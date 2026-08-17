// ============================================================
// CIFRA BAND API
// Busca inteligente de cifras no Cifra Club
// ============================================================

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();

const port = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÕES
// ============================================================

const CACHE_TTL = 60 * 60 * 1000; // 1 hora
const MAX_CACHE_ITEMS = 500;

const REQUEST_TIMEOUT = 9000;

// Quantas URLs podemos testar ao mesmo tempo
const MAX_PARALLEL_REQUESTS = 4;

const CIFA_CLUB_BASE = 'https://www.cifraclub.com.br';

// ============================================================
// CACHE
// ============================================================

const cache = new Map();
const inFlight = new Map();

// ============================================================
// AXIOS
// ============================================================

const httpClient = axios.create({
    timeout: REQUEST_TIMEOUT,

    headers: {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

        'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,' +
            'image/avif,image/webp,image/apng,*/*;q=0.8',

        'Accept-Language':
            'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',

        'Cache-Control': 'no-cache',

        'Pragma': 'no-cache',
    },

    maxRedirects: 5,

    validateStatus: (status) =>
        status >= 200 && status < 400,
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'Cifra Band API',
        version: 'V5-SmartSearch',
        timestamp: new Date().toISOString(),
    });
});

// ============================================================
// NORMALIZAÇÃO
// ============================================================

function normalizeText(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeForComparison(text) {
    let clean = normalizeText(text);

    // Remove informações que normalmente aparecem
    // no nome da música do iTunes/Cifra Club.
    clean = clean
        .replace(/\bao vivo\b/g, '')
        .replace(/\baovivo\b/g, '')
        .replace(/\blive\b/g, '')
        .replace(/\bversao\b/g, '')
        .replace(/\bversao \d+\b/g, '')
        .replace(/\bsimplificada\b/g, '')
        .replace(/\bprincipal\b/g, '')
        .replace(/\bcompleta\b/g, '')
        .replace(/\bpart\b/g, '')
        .replace(/\bfeat\b/g, '')
        .replace(/\bft\b/g, '')
        .replace(/\bparticipacao\b/g, '')
        .replace(/\bvideo\b/g, '')
        .replace(/\bcifra\b/g, '');

    return clean
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================================
// SLUG DO ARTISTA
// ============================================================

function formatArtistSlug(text) {
    let clean = String(text || '').toLowerCase().trim();

    // Remove convidados
    clean = clean
        .split(',')[0]
        .split('&')[0]
        .split('+')[0]
        .split(' feat ')[0]
        .split(' ft ')[0]
        .split(' feat. ')[0]
        .split(' part ')[0]
        .trim();

    const normalized = normalizeText(clean);

    // ========================================================
    // ALIASES IMPORTANTES
    // ========================================================

    const aliases = {
        'morada': 'morada',
        'ministerio morada': 'ministerio-morada',

        'fhop music': 'florianopolis-house-of-prayer',
        'fhop': 'florianopolis-house-of-prayer',
        'florianopolis house of prayer': 'florianopolis-house-of-prayer',

        'drops ina': 'drops-ina',

        'isaias saad': 'isaias-saad',

        'julliany souza': 'julliany-souza',

        'felipe rodrigues': 'felipe-rodrigues',

        'diante do trono': 'diante-do-trono',

        'gabriel guedes': 'gabriel-guedes',

        'casa worship': 'casa-worship',

        'ministerio zoe': 'ministerio-zoe',

        'fernandinho': 'fernandinho',

        'renascer praise': 'renascer-praise',
    };

    if (aliases[normalized]) {
        return aliases[normalized];
    }

    return normalized
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

// ============================================================
// SLUG DA MÚSICA
// ============================================================

function formatTrackSlug(text) {
    let clean = String(text || '').toLowerCase().trim();

    // ========================================================
    // REGRAS ESPECIAIS
    // ========================================================

    if (clean.includes('sublime')) {
        return 'sublime-uma-vez';
    }

    // Remove informações de gravação
    clean = clean
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '');

    clean = clean
        .replace(/\bao vivo\b/gi, '')
        .replace(/\blive\b/gi, '');

    clean = clean
        .replace(/[\/+]/g, ' ');

    return normalizeText(clean)
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

// ============================================================
// VARIAÇÕES DO ARTISTA
// ============================================================

function generateArtistSlugs(artist) {
    const original = formatArtistSlug(artist);

    const normalized = normalizeText(artist);

    const slugs = new Set();

    if (original) {
        slugs.add(original);
    }

    // Nome original
    const basic = normalized
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '-');

    if (basic) {
        slugs.add(basic);
    }

    // Possíveis prefixos usados pelo Cifra Club
    if (basic) {
        slugs.add(`ministerio-${basic}`);
        slugs.add(`banda-${basic}`);
        slugs.add(`grupo-${basic}`);
    }

    // ========================================================
    // ALIASES
    // ========================================================

    const aliases = {
        'morada': [
            'morada',
            'ministerio-morada',
        ],

        'ministerio morada': [
            'ministerio-morada',
            'morada',
        ],

        'drops ina': [
            'drops-ina',
        ],

        'fhop music': [
            'florianopolis-house-of-prayer',
            'fhop-music',
        ],

        'fhop': [
            'florianopolis-house-of-prayer',
            'fhop-music',
        ],

        'florianopolis house of prayer': [
            'florianopolis-house-of-prayer',
        ],
    };

    if (aliases[normalized]) {
        for (const alias of aliases[normalized]) {
            slugs.add(alias);
        }
    }

    return [...slugs];
}

// ============================================================
// VARIAÇÕES DO TÍTULO
// ============================================================

function generateTrackSlugs(track) {
    const original = String(track || '').trim();

    const slugs = new Set();

    const base = formatTrackSlug(original);

    if (base) {
        slugs.add(base);
    }

    // Remove palavras comuns
    const withoutLive = normalizeText(original)
        .replace(/\bao vivo\b/g, '')
        .replace(/\blive\b/g, '')
        .replace(/\bversao ao vivo\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (withoutLive) {
        slugs.add(
            withoutLive
                .replace(/[^a-z0-9 ]/g, '')
                .replace(/\s+/g, '-')
        );
    }

    // ========================================================
    // MEDLEYS
    // ========================================================

    const parts = withoutLive
        .split(/[\/+]/)
        .map((x) => x.trim())
        .filter((x) => x.length > 2);

    if (parts.length > 0) {
        for (const part of parts) {
            const slug = part
                .replace(/[^a-z0-9 ]/g, '')
                .trim()
                .replace(/\s+/g, '-');

            if (slug) {
                slugs.add(slug);
            }
        }
    }

    // ========================================================
    // SUFIXOS COMUNS DO CIFRA CLUB
    // ========================================================

    const snapshot = [...slugs];

    for (const slug of snapshot) {
        slugs.add(`${slug}-2`);
        slugs.add(`${slug}-3`);
        slugs.add(`${slug}-4`);
    }

    return [...slugs];
}

// ============================================================
// CANDIDATOS DIRETOS
// ============================================================

function generateCandidates(artist, track) {
    const artistSlugs = generateArtistSlugs(artist);
    const trackSlugs = generateTrackSlugs(track);

    const urls = [];

    for (const artistSlug of artistSlugs) {
        for (const trackSlug of trackSlugs) {
            urls.push(
                `${CIFA_CLUB_BASE}/${artistSlug}/${trackSlug}/`
            );
        }
    }

    // ========================================================
    // REGRAS ESPECIAIS
    // ========================================================

    const normalizedTrack = normalizeText(track);

    // Julliany Souza
    if (
        normalizedTrack.includes('ah jesus') ||
        normalizedTrack.includes('coracao igual')
    ) {
        for (const artistSlug of artistSlugs) {
            urls.push(
                `${CIFA_CLUB_BASE}/${artistSlug}/ah-jesus-coracao-igual-ao-teu-2-2/`
            );
        }
    }

    // Aline Barros
    if (normalizedTrack.includes('consagracao')) {
        for (const artistSlug of artistSlugs) {
            urls.push(
                `${CIFA_CLUB_BASE}/${artistSlug}/consagracao/`
            );
        }
    }

    // ========================================================
    // LIMITA DUPLICADOS
    // ========================================================

    return [...new Set(urls)];
}

// ============================================================
// CACHE
// ============================================================

function cleanExpiredCache() {
    const now = Date.now();

    for (const [key, value] of cache) {
        if (now - value.createdAt > CACHE_TTL) {
            cache.delete(key);
        }
    }

    while (cache.size > MAX_CACHE_ITEMS) {
        const firstKey = cache.keys().next().value;

        if (firstKey) {
            cache.delete(firstKey);
        } else {
            break;
        }
    }
}

function saveCache(key, data) {
    cleanExpiredCache();

    cache.set(key, {
        data,
        createdAt: Date.now(),
    });
}

function getCache(key) {
    const item = cache.get(key);

    if (!item) {
        return null;
    }

    if (Date.now() - item.createdAt > CACHE_TTL) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

// ============================================================
// UTILITÁRIO: EXECUTAR EM LOTES
// ============================================================

async function runInBatches(items, worker, batchSize) {
    const results = [];

    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);

        const batchResults = await Promise.all(
            batch.map((item) => worker(item))
        );

        results.push(...batchResults);
    }

    return results;
}

// ============================================================
// LIMPAR TEXTO DA CIFRA
// ============================================================

function cleanSongContent(content) {
    return String(content || '')
        .replace(/\[\/?(b|i)\]/gi, '')
        .replace(/\r/g, '')
        .split('\n')
        .filter((line) => line.trim())
        .join('\n')
        .trim();
}

// ============================================================
// EXTRAIR CONTEÚDO
// ============================================================

function extractSongContent($) {
    // Primeira opção: PRE
    const preElements = $('pre');

    if (preElements.length > 0) {
        let best = '';

        preElements.each((index, element) => {
            const text = $(element).text().trim();

            if (text.length > best.length) {
                best = text;
            }
        });

        if (best.length > 100) {
            return cleanSongContent(best);
        }
    }

    // ========================================================
    // FALLBACK
    // ========================================================

    const possibleSelectors = [
        '[data-testid*="chord"]',
        '[class*="chord"]',
        '[class*="cifra"]',
        'article',
        'main',
    ];

    let best = '';

    for (const selector of possibleSelectors) {
        $(selector).each((index, element) => {
            const text = $(element).text().trim();

            if (text.length > best.length) {
                best = text;
            }
        });
    }

    return cleanSongContent(best);
}

// ============================================================
// EXTRAIR TOM / FORMA / CAPOTRASTE
// ============================================================

function extractKeyInfo($, contentText) {
    const bodyText = $('body')
        .text()
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

    let originalKey = '';
    let shapeKey = '';
    let capo = '';

    // ========================================================
    // TOM
    // ========================================================

    const keyPatterns = [
        /Tom:\s*([A-G](?:#|b)?)(?:\s*\(\s*forma(?:\s+dos\s+acordes)?\s+(?:no\s+tom\s+de|do\s+tom\s+de|em|de)\s*([A-G](?:#|b)?)\s*\))?/i,

        /Tom:\s*([A-G](?:#|b)?)(?:\s*\(\s*com\s+forma\s+(?:de|no\s+tom\s+de)\s*([A-G](?:#|b)?)\s*\))?/i,

        /tom:\s*([A-G](?:#|b)?)/i,
    ];

    for (const pattern of keyPatterns) {
        const match = bodyText.match(pattern);

        if (match) {
            originalKey = match[1]?.trim() || '';
            shapeKey = match[2]?.trim() || '';

            if (originalKey) {
                break;
            }
        }
    }

    // ========================================================
    // FORMA DOS ACORDES
    // ========================================================

    if (!shapeKey) {
        const shapePatterns = [
            /forma\s+dos\s+acordes\s+no\s+tom\s+de\s*([A-G](?:#|b)?)/i,

            /forma\s+dos\s+acordes\s+do\s+tom\s+de\s*([A-G](?:#|b)?)/i,

            /forma\s+dos\s+acordes\s+em\s*([A-G](?:#|b)?)/i,

            /com\s+forma\s+de\s*([A-G](?:#|b)?)/i,

            /forma\s+de\s*([A-G](?:#|b)?)/i,
        ];

        for (const pattern of shapePatterns) {
            const match = bodyText.match(pattern);

            if (match) {
                shapeKey = match[1].trim();
                break;
            }
        }
    }

    // ========================================================
    // CAPOTRASTE
    // ========================================================

    const capoPatterns = [
        /Capotraste:\s*(\d+)\s*(?:ª|a|º|°)?\s*casa/i,

        /Capotraste\s+na\s+(\d+)\s*(?:ª|a|º|°)?\s*casa/i,

        /Capo:\s*(\d+)/i,

        /capotraste\s+(\d+)/i,
    ];

    for (const pattern of capoPatterns) {
        const match = bodyText.match(pattern);

        if (match) {
            capo = match[1];
            break;
        }
    }

    // ========================================================
    // FALLBACK: PRIMEIRO ACORDE
    // ========================================================

    if (!originalKey) {
        const firstChordMatch = String(contentText || '').match(
            /\b([A-G](?:#|b)?)(?:m|maj|dim|aug|sus|add|M)?\d*(?:\/[A-G](?:#|b)?)?\b/
        );

        if (firstChordMatch) {
            originalKey = firstChordMatch[1];
        }
    }

    if (!shapeKey && originalKey) {
        shapeKey = originalKey;
    }

    return {
        originalKey,
        shapeKey,
        capo,
    };
}

// ============================================================
// VALIDAR SE A PÁGINA REALMENTE É UMA CIFRA
// ============================================================

function isValidSongPage($, content) {
    if (!content || content.trim().length < 100) {
        return false;
    }

    const bodyText = $('body').text().toLowerCase();

    const hasSongSignals =
        bodyText.includes('tom:') ||
        bodyText.includes('cifra') ||
        bodyText.includes('acordes') ||
        bodyText.includes('afinação') ||
        bodyText.includes('capotraste');

    return hasSongSignals;
}

// ============================================================
// ABRIR UMA CIFRA
// ============================================================

async function fetchSongPage(url) {
    try {
        const response = await httpClient.get(url);

        const $ = cheerio.load(response.data);

        const content = extractSongContent($);

        if (!isValidSongPage($, content)) {
            return null;
        }

        const keyInfo = extractKeyInfo($, content);

        // Tenta obter título real
        let realTitle = $('h1').first().text().trim();

        if (!realTitle) {
            realTitle = $('title').text().split('-')[0].trim();
        }

        // Tenta obter artista
        let realArtist = '';

        const artistSelectors = [
            'a[href*="/"][class*="artist"]',
            '[class*="artist"]',
        ];

        for (const selector of artistSelectors) {
            const value = $(selector).first().text().trim();

            if (value) {
                realArtist = value;
                break;
            }
        }

        return {
            title: realTitle || '',
            artist: realArtist || '',
            originalKey: keyInfo.originalKey,
            shapeKey: keyInfo.shapeKey,
            capo: keyInfo.capo,
            content,
            url: response.request?.res?.responseUrl || url,
            source: 'cifraclub',
        };
    } catch (error) {
        return null;
    }
}

// ============================================================
// SCORE DE SIMILARIDADE
// ============================================================

function calculateSimilarity(target, candidate) {
    const a = normalizeForComparison(target);
    const b = normalizeForComparison(candidate);

    if (!a || !b) {
        return 0;
    }

    if (a === b) {
        return 100;
    }

    const aWords = new Set(a.split(' ').filter(Boolean));
    const bWords = new Set(b.split(' ').filter(Boolean));

    let common = 0;

    for (const word of aWords) {
        if (bWords.has(word)) {
            common++;
        }
    }

    const maxWords = Math.max(aWords.size, bWords.size);

    if (!maxWords) {
        return 0;
    }

    let score = (common / maxWords) * 100;

    // Contenção
    if (a.includes(b) || b.includes(a)) {
        score += 20;
    }

    return Math.min(score, 100);
}

// ============================================================
// EXTRAIR LINKS DE CIFRA DA PÁGINA
// ============================================================

function extractCifraLinks($) {
    const links = [];

    $('a[href]').each((index, element) => {
        const href = $(element).attr('href');

        if (!href) {
            return;
        }

        let absoluteUrl;

        try {
            absoluteUrl = new URL(
                href,
                CIFA_CLUB_BASE
            ).toString();
        } catch (_) {
            return;
        }

        if (!absoluteUrl.includes('cifraclub.com.br')) {
            return;
        }

        const parsed = new URL(absoluteUrl);

        const pathname = parsed.pathname;

        const parts = pathname
            .split('/')
            .filter(Boolean);

        // Esperamos algo como:
        // /ministerio-morada/e-tudo-sobre-voce/
        if (parts.length < 2) {
            return;
        }

        // Ignora áreas que não são músicas
        const ignored = [
            'search',
            'login',
            'cadastro',
            'acesso',
            'artistas',
            'listas',
            'blog',
            'forum',
            'academy',
            'store',
            'videos',
        ];

        if (ignored.includes(parts[0])) {
            return;
        }

        const text = $(element)
            .text()
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) {
            return;
        }

        links.push({
            url: absoluteUrl,
            text,
            artistSlug: parts[0],
            trackSlug: parts[1],
        });
    });

    return links;
}

// ============================================================
// BUSCA INTELIGENTE NO CIFRA CLUB
// ============================================================

async function searchCifraClub(artist, track) {
    const queries = [
        `${artist} ${track}`,
        `${track} ${artist}`,
        track,
    ];

    const allCandidates = [];

    for (const query of queries) {
        try {
            console.log(`🔎 Busca Cifra Club: ${query}`);

            const url =
                `${CIFA_CLUB_BASE}/?q=${encodeURIComponent(query)}`;

            const response = await httpClient.get(url);

            const $ = cheerio.load(response.data);

            const links = extractCifraLinks($);

            for (const link of links) {
                const titleScore =
                    calculateSimilarity(track, link.text);

                const artistScore =
                    calculateSimilarity(artist, link.artistSlug);

                const combinedScore =
                    (titleScore * 0.75) +
                    (artistScore * 0.25);

                allCandidates.push({
                    ...link,
                    score: combinedScore,
                    titleScore,
                    artistScore,
                });
            }

            // Se já temos resultado muito forte,
            // não precisamos continuar procurando.
            if (
                allCandidates.some(
                    (item) => item.score >= 92
                )
            ) {
                break;
            }
        } catch (error) {
            console.log(
                `⚠️ Falha na busca "${query}": ${error.message}`
            );
        }
    }

    // Remove duplicados
    const unique = [];

    const seen = new Set();

    for (const candidate of allCandidates) {
        if (!seen.has(candidate.url)) {
            seen.add(candidate.url);
            unique.push(candidate);
        }
    }

    // Ordena do melhor para o pior
    unique.sort((a, b) => b.score - a.score);

    console.log(
        `🔍 Resultados inteligentes: ${unique.length}`
    );

    if (unique.length > 0) {
        console.log(
            `🏆 Melhor candidato: ${unique[0].url} ` +
            `(score ${unique[0].score.toFixed(1)})`
        );
    }

    return unique;
}

// ============================================================
// TENTATIVA DIRETA
// ============================================================

async function tryDirectCandidates(candidates) {
    console.log(
        `🎯 Testando ${candidates.length} URLs diretas...`
    );

    let bestResult = null;

    await runInBatches(
        candidates,
        async (url) => {
            if (bestResult) {
                return;
            }

            const result = await fetchSongPage(url);

            if (result && result.content) {
                bestResult = result;
            }
        },
        MAX_PARALLEL_REQUESTS
    );

    return bestResult;
}

// ============================================================
// BUSCA POR ARTISTA + MÚSICA
// ============================================================

async function smartSearch(artist, track) {
    // ========================================================
    // ETAPA 1
    // URLs DIRETAS
    // ========================================================

    const directCandidates =
        generateCandidates(artist, track);

    console.log(
        `🎯 Candidatos diretos: ${directCandidates.length}`
    );

    const directResult =
        await tryDirectCandidates(directCandidates);

    if (directResult) {
        console.log(
            `✅ Encontrada pela URL direta: ${directResult.url}`
        );

        return directResult;
    }

    // ========================================================
    // ETAPA 2
    // BUSCA DO CIFRA CLUB
    // ========================================================

    console.log(
        `🔎 URL direta falhou. Iniciando busca inteligente...`
    );

    const searchResults =
        await searchCifraClub(artist, track);

    // ========================================================
    // ETAPA 3
    // TESTAR OS MELHORES RESULTADOS
    // ========================================================

    const candidatesToTry =
        searchResults
            .filter((item) => item.score >= 45)
            .slice(0, 8);

    console.log(
        `🎯 Vou testar ${candidatesToTry.length} resultados encontrados.`
    );

    for (const candidate of candidatesToTry) {
        console.log(
            `🎵 Testando: ${candidate.url} ` +
            `(score ${candidate.score.toFixed(1)})`
        );

        const result =
            await fetchSongPage(candidate.url);

        if (!result) {
            continue;
        }

        // ====================================================
        // VALIDAÇÃO FINAL
        // ====================================================

        const titleScore =
            calculateSimilarity(track, result.title);

        const artistScore =
            result.artist
                ? calculateSimilarity(
                    artist,
                    result.artist
                )
                : 50;

        const finalScore =
            (titleScore * 0.8) +
            (artistScore * 0.2);

        console.log(
            `📊 Score final: ${finalScore.toFixed(1)}`
        );

        // Aceita se a música estiver suficientemente próxima
        if (finalScore >= 50 || candidate.score >= 70) {
            return result;
        }
    }

    return null;
}

// ============================================================
// ENDPOINT PRINCIPAL
// ============================================================

app.get('/searchSong', async (req, res) => {
    const artist =
        String(req.query.artist || '').trim();

    const track =
        String(req.query.track || '').trim();

    // ========================================================
    // VALIDAÇÃO
    // ========================================================

    if (!artist || !track) {
        return res.status(400).json({
            error: 'missing_parameters',
            message:
                'Informe artist e track.',
        });
    }

    // ========================================================
    // CACHE KEY
    // ========================================================

    const cacheKey =
        `${normalizeForComparison(artist)}::` +
        `${normalizeForComparison(track)}`;

    // ========================================================
    // CACHE
    // ========================================================

    const cached = getCache(cacheKey);

    if (cached) {
        console.log(
            `⚡ CACHE HIT: ${artist} - ${track}`
        );

        return res.status(200).json(cached);
    }

    // ========================================================
    // EVITAR DUAS BUSCAS SIMULTÂNEAS
    // ========================================================

    if (inFlight.has(cacheKey)) {
        console.log(
            `⏳ Busca já em andamento: ${artist} - ${track}`
        );

        try {
            const result =
                await inFlight.get(cacheKey);

            return res.status(200).json(result);
        } catch (error) {
            return res.status(
                error.statusCode || 500
            ).json({
                error:
                    error.code ||
                    'server_error',

                message:
                    error.message ||
                    'Erro interno.',
            });
        }
    }

    // ========================================================
    // BUSCA
    // ========================================================

    const requestPromise =
        (async () => {
            console.log('');
            console.log(
                '══════════════════════════════════════'
            );

            console.log(
                '🎸 CIFRA BAND — BUSCA INTELIGENTE'
            );

            console.log(
                '══════════════════════════════════════'
            );

            console.log(
                `🎤 Artista: ${artist}`
            );

            console.log(
                `🎵 Música: ${track}`
            );

            const result =
                await smartSearch(
                    artist,
                    track
                );

            if (!result) {
                const error =
                    new Error(
                        'Cifra não encontrada no Cifra Club.'
                    );

                error.code =
                    'SONG_NOT_FOUND';

                error.statusCode =
                    404;

                throw error;
            }

            // =================================================
            // CORRIGE ARTISTA/TÍTULO PARA O APP
            // =================================================

            const finalResult = {
                title:
                    result.title ||
                    track,

                artist:
                    result.artist ||
                    artist,

                originalKey:
                    result.originalKey || '',

                shapeKey:
                    result.shapeKey ||
                    result.originalKey ||
                    '',

                capo:
                    result.capo || '',

                content:
                    result.content,

                url:
                    result.url,

                source:
                    'cifraclub',

                searchedArtist:
                    artist,

                searchedTrack:
                    track,

                fetchedAt:
                    new Date().toISOString(),
            };

            // =================================================
            // CACHE
            // =================================================

            saveCache(
                cacheKey,
                finalResult
            );

            console.log(
                `✅ CIFRA ENCONTRADA`
            );

            console.log(
                `🎵 ${finalResult.title}`
            );

            console.log(
                `🎤 ${finalResult.artist}`
            );

            console.log(
                `🎼 Tom: ${finalResult.originalKey}`
            );

            console.log(
                `🎸 Forma: ${finalResult.shapeKey}`
            );

            console.log(
                `🪕 Capo: ${finalResult.capo || 'sem capo'}`
            );

            console.log(
                `🔗 ${finalResult.url}`
            );

            console.log(
                '══════════════════════════════════════'
            );

            return finalResult;
        })();

    inFlight.set(
        cacheKey,
        requestPromise
    );

    try {
        const result =
            await requestPromise;

        return res.status(200).json(result);
    } catch (error) {
        console.log('');
        console.log(
            '❌ ERRO NA BUSCA'
        );

        console.log(
            `🎤 ${artist}`
        );

        console.log(
            `🎵 ${track}`
        );

        console.log(
            `❌ ${error.message}`
        );

        return res.status(
            error.statusCode || 500
        ).json({
            error:
                error.code ||
                'server_error',

            message:
                error.message ||
                'Erro interno no servidor.',
        });
    } finally {
        inFlight.delete(cacheKey);
    }
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
    res.status(404).json({
        error: 'not_found',
        message: 'Endpoint não encontrado.',
    });
});

// ============================================================
// ERRO GLOBAL
// ============================================================

app.use((error, req, res, next) => {
    console.error(
        '🔥 Erro global:',
        error
    );

    res.status(500).json({
        error: 'internal_server_error',
        message: 'Erro interno do servidor.',
    });
});

// ============================================================
// START
// ============================================================

app.listen(
    port,
    () => {
        console.log('');
        console.log(
            '🚀 Cifra Band API V5-SmartSearch'
        );

        console.log(
            `📡 Porta: ${port}`
        );

        console.log(
            '🎸 Busca inteligente do Cifra Club ativa'
        );

        console.log(
            '🔎 Busca direta + descoberta + ranking'
        );

        console.log('');
    }
);