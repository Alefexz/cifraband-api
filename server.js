// cifra_band/functions/server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

const CACHE_TTL = 30 * 60 * 1000;
const MAX_CACHE_ITEMS = 200;
const REQUEST_TIMEOUT = 5000; // Reduzido para 5s por tentativa para não demorar muito

const cache = new Map();
const inFlight = new Map();

app.get('/', (req, res) => {
    res.status(200).json({ status: 'online', service: 'Cifra Band API', version: 'V3-Pipeline', timestamp: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// UTILITÁRIOS E SLUGS
// ─────────────────────────────────────────────

function formatArtistSlug(text) {
    let clean = String(text).toLowerCase();
    clean = clean.split(',')[0].split('&')[0].split('+')[0].split('feat')[0].split('part')[0].trim();
    
    // ⚠️ ALIAS INTELIGENTE PARA CANTORES
    if (clean === 'fhop music' || clean === 'fhop') {
        clean = 'florianopolis-house-of-prayer';
    }

    return clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
}

function formatTrackSlug(text) {
    let clean = String(text).toLowerCase();
    clean = clean.replace(/\(.*\)/g, '').replace(/\[.*\]/g, ''); // Tira (Ao Vivo)
    clean = clean.replace(/[\/\+]/g, ' '); // Troca barras e mais por espaço
    return clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-');
}

// ─────────────────────────────────────────────
// PIPELINE DE DESCOBERTA (O MOTOR DE VERDADE)
// ─────────────────────────────────────────────

function generateCandidates(artist, track) {
    const a = formatArtistSlug(artist);
    const t = formatTrackSlug(track);
    const urls = [];

    // 1. O caso especial do "Ah Jesus"
    if (t.includes('ah-jesus') && t.includes('coracao')) {
        urls.push(`https://www.cifraclub.com.br/${a}/ah-jesus-coracao-igual-ao-teu-2-2/`);
        urls.push(`https://www.cifraclub.com.br/${a}/ah-jesus-quem-e-esse/`);
    }

    // 2. A tentativa Normal
    urls.push(`https://www.cifraclub.com.br/${a}/${t}/`);
    
    // 3. Fallbacks comuns do CifraClub (Quando a página principal é só Letra)
    urls.push(`https://www.cifraclub.com.br/${a}/${t}-2/`);
    urls.push(`https://www.cifraclub.com.br/${a}/${t}-3/`);

    // Remove duplicatas pra não perder tempo
    return [...new Set(urls)];
}

// ─────────────────────────────────────────────
// CACHE E EXTRAÇÃO
// ─────────────────────────────────────────────

function cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of cache) {
        if (now - value.createdAt > CACHE_TTL) cache.delete(key);
    }
    while (cache.size > MAX_CACHE_ITEMS) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
        else break;
    }
}

function saveCache(key, data) {
    cleanExpiredCache();
    cache.set(key, { data, createdAt: Date.now() });
}

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() - item.createdAt > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return item.data;
}

function extractKeyInfo($, contentText) {
    const bodyText = $('body').text().replace(/\u00a0/g, ' ').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

    let originalKey = '';
    let shapeKey = '';
    let capo = '';

    const keyMatch = bodyText.match(/Tom:\s*([A-G](?:#|b)?)(?:\s*\(\s*com\s+forma\s+de\s*([A-G](?:#|b)?)\s*\))?/i);
    if (keyMatch) {
        originalKey = keyMatch[1].trim();
        shapeKey = keyMatch[2]?.trim() || '';
    }

    const capoMatch = bodyText.match(/Capotraste:\s*(\d+)\s*(?:ª|a|º|°)?\s*casa/i);
    if (capoMatch) capo = capoMatch[1];

    if (!shapeKey) {
        const shapeMatch = bodyText.match(/forma(?:\s+dos\s+acordes)?\s+(?:no\s+tom\s+de|de)\s*([A-G](?:#|b)?)/i);
        if (shapeMatch) shapeKey = shapeMatch[1].trim();
    }

    if (!originalKey) {
        const firstChordMatch = contentText.match(/\b[A-G][#b]?(m|maj|dim|aug|sus|add|M)?\d*(\/[A-G][#b]?)?\b/);
        if (firstChordMatch) originalKey = firstChordMatch[0].replace(/m|maj|dim|aug|sus|add|M|\d|\/.*/g, ''); 
    }

    if (!shapeKey && originalKey) shapeKey = originalKey;

    return { originalKey, shapeKey, capo };
}

function cleanSongContent(content) {
    return content.replace(/\[\/?(b|i)\]/g, '').replace(/\r/g, '').split('\n').filter(line => line.trim()).join('\n').trim();
}

// ─────────────────────────────────────────────
// ROTA PRINCIPAL
// ─────────────────────────────────────────────

app.get('/searchSong', async (req, res) => {
    const artist = String(req.query.artist || '').trim();
    const track = String(req.query.track || '').trim();

    if (!artist || !track) return res.status(400).json({ error: 'missing_parameters', message: 'Informe artist e track.' });

    const cacheKey = `${formatArtistSlug(artist)}-${formatTrackSlug(track)}`;

    const cached = getCache(cacheKey);
    if (cached) {
        console.log(`⚡ CACHE: ${artist} - ${track}`);
        return res.status(200).json(cached);
    }

    if (inFlight.has(cacheKey)) {
        try {
            return res.status(200).json(await inFlight.get(cacheKey));
        } catch (error) {
            return res.status(500).json({ error: 'search_error', message: 'Erro ao buscar cifra.' });
        }
    }

    const requestPromise = (async () => {
        const candidates = generateCandidates(artist, track);
        let foundResult = null;

        console.log(`🔎 Buscando: ${artist} - ${track}`);

        // O LOOP DE DESCOBERTA
        for (const url of candidates) {
            console.log(`📡 Tentando URL: ${url}`);
            try {
                const response = await axios.get(url, {
                    timeout: REQUEST_TIMEOUT,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                    validateStatus: status => status >= 200 && status < 400
                });

                const $ = cheerio.load(response.data);
                const content = $('pre').first().text();

                // SE TEM PRE, É CIFRA. SE TIVER VAZIO, É LETRA (PULA!)
                if (content.trim()) {
                    const keyInfo = extractKeyInfo($, content);
                    foundResult = {
                        title: track, artist, originalKey: keyInfo.originalKey, shapeKey: keyInfo.shapeKey,
                        capo: keyInfo.capo, content: cleanSongContent(content), url: url, source: 'cifraclub'
                    };
                    console.log(`✅ Cifra Encontrada em: ${url}`);
                    break; // Sai do loop, achamos a cifra!
                } else {
                    console.log(`⚠️ Página encontrada, mas é Letra (sem cifra). Tentando próxima...`);
                }
            } catch (err) {
                if (err.response?.status === 404) {
                    console.log(`❌ 404 em: ${url} - Tentando próxima...`);
                } else {
                    console.log(`⚠️ Erro de rede em ${url}`);
                }
            }
        }

        // FIM DO LOOP. Achou algo?
        if (foundResult) {
            saveCache(cacheKey, foundResult);
            return foundResult;
        } else {
            const notFoundError = new Error('Cifra não encontrada no Cifra Club após tentar variações.');
            notFoundError.code = 'SONG_NOT_FOUND';
            notFoundError.statusCode = 404;
            throw notFoundError;
        }
    })();

    inFlight.set(cacheKey, requestPromise);

    try {
        return res.status(200).json(await requestPromise);
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.code || 'server_error', message: error.message });
    } finally {
        inFlight.delete(cacheKey);
    }
});

app.listen(port, () => console.log(`🚀 Cifra Band API V3-Pipeline rodando na porta ${port}`));