// cifra_band/functions/server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

const CACHE_TTL = 30 * 60 * 1000;
const MAX_CACHE_ITEMS = 200;
const REQUEST_TIMEOUT = 8000;

const cache = new Map();
const inFlight = new Map();

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'Cifra Band API',
        version: 'V3-Lite-Fix',
        timestamp: new Date().toISOString()
    });
});

// ─────────────────────────────────────────────
// UTILITÁRIOS E SLUGS (A CORREÇÃO MÁGICA ESTÁ AQUI)
// ─────────────────────────────────────────────

function formatArtistSlug(text) {
    let clean = String(text).toLowerCase();
    // Pega só o primeiro artista e ignora feat, part, vírgulas e &
    clean = clean.split(',')[0].split('&')[0].split('+')[0].split('feat')[0].split('part')[0];
    return clean
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Tira acentos
        .replace(/[^a-z0-9 ]/g, '') // Tira caracteres estranhos
        .trim()
        .replace(/\s+/g, '-'); // Troca espaços por traço
}

function formatTrackSlug(text) {
    let clean = String(text).toLowerCase();
    // Tira os parênteses (Ao Vivo, Playback, etc) e seus conteúdos
    clean = clean.replace(/\(.*\)/g, '').replace(/\[.*\]/g, '');
    // Troca + e / por espaço para virarem traço no final (ex: "Tu és + Águas")
    clean = clean.replace(/[\/\+]/g, ' ');
    return clean
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

function cleanExpiredCache() {
    const now = Date.now();

    for (const [key, value] of cache) {
        if (now - value.createdAt > CACHE_TTL) {
            cache.delete(key);
        }
    }

    while (cache.size > MAX_CACHE_ITEMS) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
        else break;
    }
}

function saveCache(key, data) {
    cleanExpiredCache();

    cache.set(key, {
        data,
        createdAt: Date.now()
    });
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

// ─────────────────────────────────────────────
// EXTRAÇÃO DE TOM / SHAPE / CAPO
// ─────────────────────────────────────────────

function extractKeyInfo($, contentText) {
    const bodyText = $('body').text()
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

    let originalKey = '';
    let shapeKey = '';
    let capo = '';

    const keyMatch = bodyText.match(
        /Tom:\s*([A-G](?:#|b)?)(?:\s*\(\s*com\s+forma\s+de\s*([A-G](?:#|b)?)\s*\))?/i
    );

    if (keyMatch) {
        originalKey = keyMatch[1].trim();
        shapeKey = keyMatch[2]?.trim() || '';
    }

    const capoMatch = bodyText.match(
        /Capotraste:\s*(\d+)\s*(?:ª|a|º|°)?\s*casa/i
    );

    if (capoMatch) capo = capoMatch[1];

    if (!shapeKey) {
        const shapeMatch = bodyText.match(
            /forma(?:\s+dos\s+acordes)?\s+(?:no\s+tom\s+de|de)\s*([A-G](?:#|b)?)/i
        );

        if (shapeMatch) shapeKey = shapeMatch[1].trim();
    }

    // ⚠️ FALLBACK INFALÍVEL: Se o CifraClub mudou as tags, a gente caça o acorde na força bruta!
    if (!originalKey) {
        const firstChordMatch = contentText.match(/\b[A-G][#b]?(m|maj|dim|aug|sus|add|M)?\d*(\/[A-G][#b]?)?\b/);
        if (firstChordMatch) {
            originalKey = firstChordMatch[0].replace(/m|maj|dim|aug|sus|add|M|\d|\/.*/g, ''); // Pega a nota base pura
        }
    }

    if (!shapeKey && originalKey) {
        shapeKey = originalKey;
    }

    return { originalKey, shapeKey, capo };
}

// ─────────────────────────────────────────────
// LIMPEZA DA CIFRA
// ─────────────────────────────────────────────

function cleanSongContent(content) {
    return content
        .replace(/\[\/?(b|i)\]/g, '')
        .replace(/\r/g, '')
        .split('\n')
        .filter(line => line.trim())
        .join('\n')
        .trim();
}

// ─────────────────────────────────────────────
// BUSCAR CIFRA
// ─────────────────────────────────────────────

app.get('/searchSong', async (req, res) => {
    const artist = String(req.query.artist || '').trim();
    const track = String(req.query.track || '').trim();

    if (!artist || !track) {
        return res.status(400).json({
            error: 'missing_parameters',
            message: 'Informe artist e track.'
        });
    }

    // ⚠️ Usando os nossos novos limpadores de Slugs aqui
    const artistSlug = formatArtistSlug(artist);
    const trackSlug = formatTrackSlug(track);
    const cacheKey = `${artistSlug}-${trackSlug}`;

    const cached = getCache(cacheKey);

    if (cached) {
        console.log(`⚡ CACHE: ${artist} - ${track}`);
        return res.status(200).json(cached);
    }

    if (inFlight.has(cacheKey)) {
        try {
            return res.status(200).json(await inFlight.get(cacheKey));
        } catch (error) {
            return res.status(error.statusCode || 500).json({
                error: error.code || 'search_error',
                message: error.message || 'Erro ao buscar cifra.'
            });
        }
    }

    const songUrl = `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}/`;

    console.log(`🔎 Buscando: ${artist} - ${track}`);
    console.log(`🌐 URL: ${songUrl}`);

    const requestPromise = (async () => {
        try {
            const response = await axios.get(songUrl, {
                timeout: REQUEST_TIMEOUT,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language':
                        'pt-BR,pt;q=0.9,en;q=0.8'
                },
                validateStatus: status =>
                    status >= 200 && status < 400
            });

            const $ = cheerio.load(response.data);
            const content = $('pre').first().text();

            if (!content.trim()) {
                const error = new Error(
                    'A página foi encontrada, mas a cifra não foi localizada.'
                );

                error.code = 'SONG_CONTENT_NOT_FOUND';
                error.statusCode = 404;
                throw error;
            }

            const keyInfo = extractKeyInfo($, content);

            const result = {
                title: track,
                artist,
                originalKey: keyInfo.originalKey,
                shapeKey: keyInfo.shapeKey,
                capo: keyInfo.capo,
                content: cleanSongContent(content),
                url: songUrl,
                source: 'cifraclub'
            };

            if (!keyInfo.originalKey) {
                console.warn(`⚠️ Tom não identificado: ${artist} - ${track}`);
            }

            saveCache(cacheKey, result);

            console.log(
                `✅ OK: ${track} | Tom: ${keyInfo.originalKey || '?'} | ` +
                `Forma: ${keyInfo.shapeKey || '?'} | Capo: ${keyInfo.capo || '0'}`
            );

            return result;

        } catch (error) {
            if (
                error.code === 'ECONNABORTED' ||
                error.code === 'ETIMEDOUT'
            ) {
                const timeoutError = new Error(
                    'O Cifra Club demorou para responder. Tente novamente.'
                );

                timeoutError.code = 'UPSTREAM_TIMEOUT';
                timeoutError.statusCode = 504;
                throw timeoutError;
            }

            if (error.response?.status === 404) {
                const notFoundError = new Error(
                    'Cifra não encontrada. Verifique o nome da música e do artista.'
                );

                notFoundError.code = 'SONG_NOT_FOUND';
                notFoundError.statusCode = 404;
                throw notFoundError;
            }

            if (error.statusCode) throw error;

            console.error(
                `❌ Erro em ${artist} - ${track}:`,
                error.message
            );

            const scraperError = new Error(
                'Não foi possível buscar a cifra agora.'
            );

            scraperError.code = 'SCRAPER_ERROR';
            scraperError.statusCode = 502;
            throw scraperError;
        }
    })();

    inFlight.set(cacheKey, requestPromise);

    try {
        return res.status(200).json(await requestPromise);
    } catch (error) {
        return res.status(error.statusCode || 500).json({
            error: error.code || 'server_error',
            message: error.message || 'Erro interno do servidor.'
        });
    } finally {
        inFlight.delete(cacheKey);
    }
});

// ─────────────────────────────────────────────
// ERRO EXPRESS
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {
    console.error('❌ Erro Express:', err);

    res.status(500).json({
        error: 'internal_server_error',
        message: 'Erro interno do servidor.'
    });
});

// ─────────────────────────────────────────────
// SERVIDOR
// ─────────────────────────────────────────────

app.listen(port, () => {
    console.log(`🚀 Cifra Band API V3-Lite-Fix rodando na porta ${port}`);
});