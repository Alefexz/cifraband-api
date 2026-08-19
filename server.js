// ============================================================
// CIFRA BAND API
// Busca inteligente e robusta de cifras no Cifra Club
// ============================================================

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();

// FIX: sem isso, qualquer chamada vinda de um app Flutter Web (ou de
// qualquer origem diferente do próprio servidor) falha por CORS antes
// de chegar no endpoint.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

const port = process.env.PORT || 3000;

const CIFRA_BASE = 'https://www.cifraclub.com.br';

const CACHE_TTL = 12 * 60 * 60 * 1000;       // 12 horas
const CATALOG_TTL = 6 * 60 * 60 * 1000;      // 6 horas
const MAX_CACHE_ITEMS = 500;

const REQUEST_TIMEOUT = 9000;

const DIRECT_CONCURRENCY = 6;
const CATALOG_CONCURRENCY = 5;
const SEARCH_CONCURRENCY = 5;

// ============================================================
// CACHE
// ============================================================
// ATENÇÃO: isso é memória do processo. No Render free tier o servidor
// derruba depois de ~15min sem tráfego e sobe zerado — ou seja, esse
// cache (e o aprendizado de aliases) não sobrevive entre "sonos" do
// serviço. Funciona bem enquanto o processo está de pé, mas não é
// persistente de verdade. Se quiser resolver isso direito, dá pra
// trocar por um banco externo (Firestore funciona normal fora do
// Firebase Functions, só precisa de uma service account).

const songCache = new Map();
const catalogCache = new Map();
const inFlight = new Map();

// ============================================================
// USER AGENT
// ============================================================

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,image/apng,*/*;q=0.8',

    'Accept-Language':
        'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',

    'Cache-Control': 'no-cache',

    'Pragma': 'no-cache'
};

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'Cifra Band API',
        version: 'V5-Intelligent',
        timestamp: new Date().toISOString()
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
        .replace(/&/g, ' e ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ============================================================
// TOKENIZAÇÃO
// ============================================================

function tokenize(text) {
    return normalizeText(text)
        .split(' ')
        .filter(Boolean);
}

// ============================================================
// PALAVRAS GENÉRICAS
// ============================================================

const GENERIC_WORDS = new Set([
    'ao',
    'aovivo',
    'vivo',
    'live',
    'medley',
    'pot',
    'pourri',
    'versao',
    'versao2',
    'versao3',
    'simplificada',
    'principal',
    'indefinida'
]);

function significantTokens(text) {
    return tokenize(text).filter(
        token => !GENERIC_WORDS.has(token)
    );
}

// ============================================================
// SLUG ARTISTA
// ============================================================

function formatArtistSlug(text) {
    let clean = String(text || '').trim();

    clean = clean
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '');

    clean = clean
        .split(',')[0]
        .split('&')[0]
        .split('+')[0]
        .split(/\s+feat\.?\s+/i)[0]
        .split(/\s+part\.?\s+/i)[0]
        .trim();

    const normalized = normalizeText(clean);

    // Aliases importantes
    const aliases = {
        'morada': 'ministerio-morada',
        'ministerio morada': 'ministerio-morada',

        'fhop': 'florianopolis-house-of-prayer',
        'fhop music': 'florianopolis-house-of-prayer',

        'florianopolis house of prayer':
            'florianopolis-house-of-prayer',

        'aline barros': 'aline-barros'
    };

    if (aliases[normalized]) {
        return aliases[normalized];
    }

    return normalized.replace(/\s+/g, '-');
}

// ============================================================
// POSSÍVEIS SLUGS DO ARTISTA
// ============================================================

function generateArtistSlugs(artist) {
    const original = String(artist || '').trim();

    const normalized = normalizeText(original);

    const result = [];

    function add(value) {
        if (!value) return;

        const slug = String(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .toLowerCase();

        if (slug && !result.includes(slug)) {
            result.push(slug);
        }
    }

    add(formatArtistSlug(original));
    add(normalized);

    if (normalized === 'morada') {
        add('ministerio-morada');
    }

    if (normalized === 'ministerio morada') {
        add('morada');
        add('ministerio-morada');
    }

    if (normalized === 'aline') {
        add('aline-barros');
    }

    if (normalized === 'aline barros') {
        add('aline');
        add('aline-barros');
    }

    return result;
}

// ============================================================
// SLUG DA MÚSICA
// ============================================================

function basicTrackSlug(text) {
    let clean = String(text || '');

    clean = clean
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\{.*?\}/g, '');

    clean = clean
        .replace(/[\/|]/g, ' ')
        .replace(/&/g, ' e ');

    clean = clean
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return clean.replace(/\s+/g, '-');
}

// ============================================================
// POSSÍVEIS SLUGS DA MÚSICA
// ============================================================

function generateTrackSlugs(track) {
    const result = [];

    function add(value) {
        if (!value) return;

        const slug = String(value)
            .replace(/^-+|-+$/g, '')
            .replace(/-+/g, '-');

        if (slug && !result.includes(slug)) {
            result.push(slug);
        }
    }

    const base = basicTrackSlug(track);

    add(base);

    // Remove informações de apresentação
    add(
        base
            .replace(/-ao-vivo$/g, '')
            .replace(/-live$/g, '')
            .replace(/-medley$/g, '')
            .replace(/-pot-pourri$/g, '')
    );

    // Adiciona formatos comuns do Cifra Club
    add(`${base}-ao-vivo`);
    add(`${base}-medley`);
    add(`${base}-pot-pourri`);

    add(`${base}-ao-vivo-medley`);
    add(`${base}-ao-vivo-pot-pourri`);

    add(`${base}-medley-2`);
    add(`${base}-pot-pourri-2`);
    add(`${base}-2`);
    add(`${base}-3`);

    // ========================================================
    // MEDLEYS
    // ========================================================

    const parts = String(track)
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean);

    if (parts.length > 1) {
        const first = basicTrackSlug(parts[0]);

        add(first);

        for (const suffix of [
            'ao-vivo',
            'medley',
            'pot-pourri'
        ]) {
            add(`${first}-${suffix}`);
        }

        // Combinação das partes sem caracteres especiais
        const combined = parts
            .map(part => basicTrackSlug(part))
            .filter(Boolean)
            .join('-');

        add(combined);
        add(`${combined}-ao-vivo`);
        add(`${combined}-medley`);
        add(`${combined}-pot-pourri`);
    }

    return [...new Set(result)];
}

// ============================================================
// URLS DIRETAS
// ============================================================

function generateDirectCandidates(artist, track) {
    const artistSlugs = generateArtistSlugs(artist);
    const trackSlugs = generateTrackSlugs(track);

    const urls = [];

    for (const artistSlug of artistSlugs) {
        for (const trackSlug of trackSlugs) {
            urls.push(
                `${CIFRA_BASE}/${artistSlug}/${trackSlug}/`
            );
        }
    }

    return [...new Set(urls)];
}

// ============================================================
// CACHE
// ============================================================

function cleanCache(map, ttl, maxItems = MAX_CACHE_ITEMS) {
    const now = Date.now();

    for (const [key, value] of map) {
        if (now - value.createdAt > ttl) {
            map.delete(key);
        }
    }

    while (map.size > maxItems) {
        const first = map.keys().next().value;

        if (first) {
            map.delete(first);
        } else {
            break;
        }
    }
}

function saveSongCache(key, data) {
    cleanCache(songCache, CACHE_TTL);
    songCache.set(key, {
        data,
        createdAt: Date.now()
    });
}

function getSongCache(key) {
    const item = songCache.get(key);

    if (!item) return null;

    if (Date.now() - item.createdAt > CACHE_TTL) {
        songCache.delete(key);
        return null;
    }

    return item.data;
}

function saveCatalogCache(key, data) {
    cleanCache(catalogCache, CATALOG_TTL);
    catalogCache.set(key, {
        data,
        createdAt: Date.now()
    });
}

function getCatalogCache(key) {
    const item = catalogCache.get(key);

    if (!item) return null;

    if (Date.now() - item.createdAt > CATALOG_TTL) {
        catalogCache.delete(key);
        return null;
    }

    return item.data;
}

// ============================================================
// HTTP
// ============================================================

async function fetchHtml(url) {
    try {
        const response = await axios.get(url, {
            timeout: REQUEST_TIMEOUT,
            headers: HEADERS,
            maxRedirects: 5,
            validateStatus: status =>
                status >= 200 && status < 400
        });

        return {
            html: response.data,
            finalUrl: response.request?.res?.responseUrl || url,
            status: response.status
        };
    } catch (error) {
        return null;
    }
}

// ============================================================
// VALIDAR URL DO CIFRA CLUB
// ============================================================

function isValidCifraClubUrl(url) {
    try {
        const parsed = new URL(url);

        if (
            parsed.hostname !== 'www.cifraclub.com.br' &&
            parsed.hostname !== 'cifraclub.com.br'
        ) {
            return false;
        }

        const path = parsed.pathname.toLowerCase();

        // Nunca aceitar páginas genéricas
        const blocked = [
            '/letra/',
            '/search/',
            '/navegador/',
            '/wiki/',
            '/marketplace/',
            '/forum/',
            '/videos/',
            '/partituras/',
            '/tabs/',
            '/guitar-pro/'
        ];

        if (
            blocked.some(item => path.includes(item))
        ) {
            return false;
        }

        if (path.endsWith('/musicas.html')) {
            return false;
        }

        const parts = path
            .split('/')
            .filter(Boolean);

        // Precisa ter pelo menos:
        // /artista/musica/
        if (parts.length < 2) {
            return false;
        }

        return true;
    } catch (e) {
        return false;
    }
}

// ============================================================
// TEXTO DA CIFRA
// ============================================================

function extractChordContent($) {
    const candidates = [];

    $('pre').each((index, element) => {
        const text = $(element).text();

        if (text && text.trim().length > 0) {
            candidates.push(text);
        }
    });

    $('main pre').each((index, element) => {
        const text = $(element).text();

        if (text && text.trim().length > 0) {
            candidates.push(text);
        }
    });

    $('article pre').each((index, element) => {
        const text = $(element).text();

        if (text && text.trim().length > 0) {
            candidates.push(text);
        }
    });

    // Alguns layouts podem colocar a cifra em containers
    $('[class*="cifra"]').each((index, element) => {
        const text = $(element).text();

        if (
            text &&
            text.trim().length > 100 &&
            text.length < 100000
        ) {
            candidates.push(text);
        }
    });

    if (!candidates.length) {
        return '';
    }

    candidates.sort(
        (a, b) => b.length - a.length
    );

    return candidates[0].trim();
}

// ============================================================
// VERIFICA SE É REALMENTE UMA CIFRA
// ============================================================

function looksLikeChordContent(content) {
    if (!content) return false;

    const text = content.trim();

    if (text.length < 80) {
        return false;
    }

    // Acordes comuns
    const chordMatches = text.match(
        /\b[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add|M)?\d*(?:\/[A-G](?:#|b)?)?\b/g
    );

    const chordCount =
        chordMatches ? chordMatches.length : 0;

    // Tablatura também conta
    const hasTab =
        /E\|[-0-9hHpPbB\/\\|]+/i.test(text) ||
        /B\|[-0-9hHpPbB\/\\|]+/i.test(text);

    return chordCount >= 4 || hasTab;
}

// ============================================================
// LIMPEZA
// ============================================================

function cleanSongContent(content) {
    return String(content || '')
        .replace(/\[\/?(b|i)\]/gi, '')
        .replace(/\r/g, '')
        .split('\n')
        .filter(line => line.trim())
        .join('\n')
        .trim();
}

// ============================================================
// METADADOS
// ============================================================

// FIX: $('h2').first() estava pegando um heading de navegação
// ("Menu principal") em quase toda página, não o nome do artista.
// A description da página segue o padrão "Título - Artista - Cifra
// Club" de forma bem mais confiável, então agora ela é tentada
// primeiro; o h2 só entra como fallback, e nunca se o texto bater
// com um valor conhecido de "lixo" de navegação.
const BAD_ARTIST_VALUES = new Set([
    'menu principal',
    'menu',
    'cifra club',
    'navegacao',
    ''
]);

function extractPageMetadata($) {
    let title =
        $('h1').first().text().trim();

    let artist = '';

    const description =
        $('meta[name="description"]')
            .attr('content') || '';

    const descMatch =
        description.match(
            /-\s*([^-]+?)\s*-\s*Cifra Club/i
        );

    if (descMatch) {
        artist = descMatch[1].trim();
    }

    if (
        !artist ||
        BAD_ARTIST_VALUES.has(
            normalizeText(artist)
        )
    ) {
        const h2Text =
            $('h2').first().text().trim();

        if (
            h2Text &&
            !BAD_ARTIST_VALUES.has(
                normalizeText(h2Text)
            )
        ) {
            artist = h2Text;
        }
    }

    if (!title) {
        const ogTitle =
            $('meta[property="og:title"]')
                .attr('content');

        if (ogTitle) {
            title = ogTitle
                .replace(/\s*-\s*Cifra Club.*$/i, '')
                .trim();
        }
    }

    return {
        title,
        artist
    };
}

// ============================================================
// INFORMAÇÕES DE TOM
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

    const keyMatch = bodyText.match(
        /tom:\s*([A-G](?:#|b)?)(?:\s*\(\s*forma\s+dos\s+acordes\s+no\s+tom\s+de\s*([A-G](?:#|b)?)\s*\))?/i
    );

    if (keyMatch) {
        originalKey = keyMatch[1].trim();
        shapeKey =
            keyMatch[2]?.trim() || '';
    }

    // Outra forma encontrada no site
    if (!originalKey) {
        const alternativeKey =
            bodyText.match(
                /Tom:\s*([A-G](?:#|b)?)/i
            );

        if (alternativeKey) {
            originalKey =
                alternativeKey[1].trim();
        }
    }

    // ========================================================
    // FORMA
    // ========================================================

    if (!shapeKey) {
        const shapeMatch =
            bodyText.match(
                /forma(?:\s+dos\s+acordes)?\s+(?:no\s+tom\s+de|de)\s*([A-G](?:#|b)?)/i
            );

        if (shapeMatch) {
            shapeKey =
                shapeMatch[1].trim();
        }
    }

    // ========================================================
    // CAPO
    // ========================================================

    const capoPatterns = [
        /Capotraste:\s*(\d+)\s*(?:ª|a|º|°)?\s*casa/i,
        /Capotraste\s+na\s+(\d+)\s*(?:ª|a|º|°)?\s*casa/i,
        /capo:\s*(\d+)/i,
        /capotraste\s+(\d+)/i
    ];

    for (const pattern of capoPatterns) {
        const match = bodyText.match(pattern);

        if (match) {
            capo = match[1];
            break;
        }
    }

    // ========================================================
    // FALLBACK PELO PRIMEIRO ACORDE
    // ========================================================

    if (!originalKey) {
        const firstChordMatch =
            contentText.match(
                /\b([A-G](?:#|b)?)(?:m|maj|dim|aug|sus|add|M)?\d*(?:\/[A-G](?:#|b)?)?\b/
            );

        if (firstChordMatch) {
            originalKey =
                firstChordMatch[1];
        }
    }

    if (!shapeKey && originalKey) {
        shapeKey = originalKey;
    }

    return {
        originalKey,
        shapeKey,
        capo
    };
}

// ============================================================
// SIMILARIDADE
// ============================================================

function similarity(a, b) {
    const aTokens =
        significantTokens(a);

    const bTokens =
        significantTokens(b);

    if (!aTokens.length || !bTokens.length) {
        return 0;
    }

    const aSet = new Set(aTokens);
    const bSet = new Set(bTokens);

    let intersection = 0;

    for (const token of aSet) {
        if (bSet.has(token)) {
            intersection++;
        }
    }

    const union =
        new Set([
            ...aSet,
            ...bSet
        ]).size;

    const jaccard =
        union > 0
            ? intersection / union
            : 0;

    const containmentA =
        intersection / aSet.size;

    const containmentB =
        intersection / bSet.size;

    return Math.max(
        jaccard,
        containmentA * 0.95,
        containmentB * 0.90
    );
}

// ============================================================
// SCORE DA MÚSICA
// ============================================================

function scoreSong(requestedArtist, requestedTrack, foundArtist, foundTitle) {
    const titleSimilarity =
        similarity(
            requestedTrack,
            foundTitle
        );

    const artistSimilarity =
        similarity(
            requestedArtist,
            foundArtist
        );

    let score =
        titleSimilarity * 75 +
        artistSimilarity * 25;

    const normalizedRequested =
        normalizeText(requestedTrack);

    const normalizedFound =
        normalizeText(foundTitle);

    if (
        normalizedRequested ===
        normalizedFound
    ) {
        score += 30;
    }

    const requestedTokens =
        significantTokens(requestedTrack);

    const foundTokens =
        significantTokens(foundTitle);

    if (
        requestedTokens.length > 0 &&
        requestedTokens.every(
            token => foundTokens.includes(token)
        )
    ) {
        score += 15;
    }

    return score;
}

// ============================================================
// BUSCA E VALIDA UMA PÁGINA
// ============================================================

async function inspectSongUrl(
    url,
    requestedArtist,
    requestedTrack
) {
    if (!isValidCifraClubUrl(url)) {
        return null;
    }

    const page = await fetchHtml(url);

    if (!page) {
        return null;
    }

    const $ =
        cheerio.load(page.html);

    const content =
        extractChordContent($);

    if (!looksLikeChordContent(content)) {
        return null;
    }

    const metadata =
        extractPageMetadata($);

    const pageTitle =
        metadata.title || requestedTrack;

    const pageArtist =
        metadata.artist || requestedArtist;

    const score =
        scoreSong(
            requestedArtist,
            requestedTrack,
            pageArtist,
            pageTitle
        );

    // ========================================================
    // NÃO ACEITAR RESULTADO MUITO DISTANTE
    // ========================================================

    if (score < 45) {
        return null;
    }

    const keyInfo =
        extractKeyInfo(
            $,
            content
        );

    return {
        title: pageTitle,
        artist: pageArtist,

        originalKey:
            keyInfo.originalKey,

        shapeKey:
            keyInfo.shapeKey,

        capo:
            keyInfo.capo,

        content:
            cleanSongContent(content),

        url:
            page.finalUrl || url,

        source:
            'cifraclub',

        score
    };
}

// ============================================================
// EXECUTOR CONCORRENTE
// ============================================================

async function runConcurrent(
    items,
    concurrency,
    worker
) {
    const results = [];

    let index = 0;

    async function runner() {
        while (true) {
            const current =
                index++;

            if (current >= items.length) {
                return;
            }

            try {
                const result =
                    await worker(items[current]);

                if (result) {
                    results.push(result);
                }
            } catch (error) {
                // Ignora falha individual
            }
        }
    }

    const workers = [];

    const amount =
        Math.min(
            concurrency,
            items.length
        );

    for (let i = 0; i < amount; i++) {
        workers.push(runner());
    }

    await Promise.all(workers);

    return results;
}

// ============================================================
// BUSCA DIRETA
// ============================================================

async function searchDirect(
    artist,
    track
) {
    const candidates =
        generateDirectCandidates(
            artist,
            track
        );

    console.log(
        `🎯 Candidatos diretos: ${candidates.length}`
    );

    const results =
        await runConcurrent(
            candidates,
            DIRECT_CONCURRENCY,
            async url => {
                const result =
                    await inspectSongUrl(
                        url,
                        artist,
                        track
                    );

                if (result) {
                    console.log(
                        `✅ URL válida: ${result.url}`
                    );
                }

                return result;
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// CATÁLOGO DO ARTISTA
// ============================================================

async function fetchArtistCatalog(
    artistSlug
) {
    const cached =
        getCatalogCache(
            artistSlug
        );

    if (cached) {
        return cached;
    }

    const urls = [
        `${CIFRA_BASE}/${artistSlug}/`,
        `${CIFRA_BASE}/${artistSlug}/musicas.html`
    ];

    const links = [];

    for (const url of urls) {
        const page =
            await fetchHtml(url);

        if (!page) continue;

        const $ =
            cheerio.load(page.html);

        $('a[href]').each(
            (index, element) => {
                const href =
                    $(element).attr('href');

                if (!href) return;

                try {
                    const absolute =
                        new URL(
                            href,
                            CIFRA_BASE
                        ).toString();

                    if (
                        isValidCifraClubUrl(
                            absolute
                        )
                    ) {
                        const text =
                            $(element)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();

                        links.push({
                            url: absolute,
                            title: text
                        });
                    }
                } catch (error) {}
            }
        );
    }

    const unique =
        new Map();

    for (const item of links) {
        const cleanUrl =
            item.url
                .split('?')[0]
                .replace(/\/+$/, '') + '/';

        if (!unique.has(cleanUrl)) {
            unique.set(cleanUrl, {
                url: cleanUrl,
                title: item.title
            });
        }
    }

    const catalog =
        [...unique.values()];

    saveCatalogCache(
        artistSlug,
        catalog
    );

    console.log(
        `📚 Catálogo ${artistSlug}: ${catalog.length} URLs`
    );

    return catalog;
}

// ============================================================
// BUSCA NO CATÁLOGO DO ARTISTA
// ============================================================

async function searchArtistCatalog(
    artist,
    track
) {
    const artistSlugs =
        generateArtistSlugs(
            artist
        );

    const allCandidates = [];

    for (const artistSlug of artistSlugs) {
        const catalog =
            await fetchArtistCatalog(
                artistSlug
            );

        for (const item of catalog) {
            const score =
                scoreSong(
                    artist,
                    track,
                    artist,
                    item.title
                );

            if (score >= 35) {
                allCandidates.push({
                    ...item,
                    score
                });
            }
        }
    }

    const unique =
        new Map();

    for (const item of allCandidates) {
        if (
            !unique.has(item.url) ||
            unique.get(item.url).score <
                item.score
        ) {
            unique.set(
                item.url,
                item
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .slice(0, 15);

    console.log(
        `🏆 Catálogo: ${ranked.length} candidatos`
    );

    if (!ranked.length) {
        return [];
    }

    const results =
        await runConcurrent(
            ranked,
            CATALOG_CONCURRENCY,
            async item => {
                return await inspectSongUrl(
                    item.url,
                    artist,
                    track
                );
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// BUSCA INTERNA DO CIFRA CLUB
// ============================================================
// FIX: o site usa caminho com slug (ex: /search/nadson-sinal/), não
// query string (?q=). Confirmei isso testando de verdade contra o
// site antes desta correção — usar ?q= provavelmente caía na página
// genérica de busca, não em resultados da query.

async function searchCifraClub(
    artist,
    track
) {
    const queries = [
        `${track} ${artist}`,
        `${artist} ${track}`,
        track
    ];

    const links = [];

    for (const query of queries) {
        const slug =
            normalizeText(query)
                .replace(/\s+/g, '-');

        if (!slug) continue;

        try {
            const response =
                await axios.get(
                    `${CIFRA_BASE}/search/${encodeURIComponent(slug)}/`,
                    {
                        timeout:
                            REQUEST_TIMEOUT,
                        headers: HEADERS
                    }
                );

            const $ =
                cheerio.load(
                    response.data
                );

            $('a[href]').each(
                (index, element) => {
                    const href =
                        $(element).attr('href');

                    if (!href) return;

                    try {
                        const absolute =
                            new URL(
                                href,
                                CIFRA_BASE
                            ).toString();

                        if (
                            !isValidCifraClubUrl(
                                absolute
                            )
                        ) {
                            return;
                        }

                        const title =
                            $(element)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();

                        links.push({
                            url: absolute,
                            title
                        });
                    } catch (error) {}
                }
            );
        } catch (error) {
            console.log(
                `⚠️ Busca interna falhou: ${query} (${error.message})`
            );
        }
    }

    const unique =
        new Map();

    for (const item of links) {
        const score =
            scoreSong(
                artist,
                track,
                '',
                item.title
            );

        if (
            !unique.has(item.url) ||
            unique.get(item.url).score <
                score
        ) {
            unique.set(
                item.url,
                {
                    ...item,
                    score
                }
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .slice(0, 15);

    console.log(
        `🔍 Busca interna: ${ranked.length} candidatos válidos`
    );

    const results =
        await runConcurrent(
            ranked,
            SEARCH_CONCURRENCY,
            async item => {
                return await inspectSongUrl(
                    item.url,
                    artist,
                    track
                );
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// ESCOLHER MELHOR RESULTADO
// ============================================================

function chooseBestResult(
    results
) {
    if (!results.length) {
        return null;
    }

    const sorted =
        [...results].sort(
            (a, b) =>
                b.score - a.score
        );

    return sorted[0];
}

// ============================================================
// BUSCA PRINCIPAL
// ============================================================

async function findSong(
    artist,
    track
) {
    console.log('');
    console.log(
        '══════════════════════════════════════'
    );
    console.log(
        '🎸 CIFRA BAND — BUSCA INTELIGENTE V5'
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

    // ========================================================
    // 1. DIRETA
    // ========================================================

    console.log('');
    console.log(
        '1️⃣ TESTANDO URLs DIRETAS...'
    );

    // FIX: acumula os resultados de TODAS as etapas aqui. Antes,
    // "results" era reatribuída a cada etapa e a etapa 4 só enxergava
    // o que a etapa 3 tinha achado — qualquer candidato válido, mas
    // com score abaixo do limiar de aceite imediato de uma etapa
    // anterior, era descartado pra sempre em vez de virar fallback.
    const allResults = [];

    let results =
        await searchDirect(
            artist,
            track
        );

    allResults.push(...results);

    let best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 90
    ) {
        console.log(
            `🏆 Encontrada pela URL direta`
        );

        return best;
    }

    // ========================================================
    // 2. CATÁLOGO DO ARTISTA
    // ========================================================

    console.log('');
    console.log(
        '2️⃣ CONSULTANDO CATÁLOGO DO ARTISTA...'
    );

    results =
        await searchArtistCatalog(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 70
    ) {
        console.log(
            `🏆 Encontrada no catálogo do artista`
        );

        return best;
    }

    // ========================================================
    // 3. BUSCA INTERNA
    // ========================================================

    console.log('');
    console.log(
        '3️⃣ BUSCA INTERNA DO CIFRA CLUB...'
    );

    results =
        await searchCifraClub(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 65
    ) {
        console.log(
            `🏆 Encontrada pela busca interna`
        );

        return best;
    }

    // ========================================================
    // 4. ÚLTIMA TENTATIVA
    // ========================================================

    console.log('');
    console.log(
        `4️⃣ ÚLTIMA TENTATIVA COM TODOS OS RESULTADOS (${allResults.length} ao todo)...`
    );

    best =
        chooseBestResult(
            allResults
        );

    if (
        best &&
        best.score >= 55
    ) {
        console.log(
            `⚠️ Resultado aceito com score ${best.score.toFixed(1)}`
        );

        return best;
    }

    throw Object.assign(
        new Error(
            'Cifra não encontrada no Cifra Club.'
        ),
        {
            code: 'SONG_NOT_FOUND',
            statusCode: 404
        }
    );
}

// ============================================================
// ENDPOINT
// ============================================================

// FIX (rede de segurança): algumas chamadas estão chegando com o
// nome do artista duplicado dentro do campo track, tipo
// "Aline Barros - Dança do Pinguim" em vez de só "Dança do Pinguim".
// Isso confunde geração de slug e pontuação de similaridade. O ideal
// é achar de onde isso vem no app Flutter e corrigir na origem —
// mas aqui a gente corta o prefixo se ele bater com o artista
// informado, pra não depender só disso.
function stripDuplicatedArtistPrefix(artist, track) {
    const cleanArtist = String(artist || '').trim();
    const cleanTrack = String(track || '').trim();

    if (!cleanArtist || !cleanTrack) {
        return cleanTrack;
    }

    const escaped = cleanArtist.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
    );

    const prefixPattern = new RegExp(
        `^${escaped}\\s*[-:]\\s*`,
        'i'
    );

    if (prefixPattern.test(cleanTrack)) {
        const stripped =
            cleanTrack
                .replace(prefixPattern, '')
                .trim();

        if (stripped) {
            console.log(
                `🧹 Prefixo de artista removido do track: "${cleanTrack}" -> "${stripped}"`
            );
            return stripped;
        }
    }

    return cleanTrack;
}

app.get(
    '/searchSong',
    async (req, res) => {
        const artist =
            String(
                req.query.artist || ''
            ).trim();

        const track = stripDuplicatedArtistPrefix(
            artist,
            String(
                req.query.track || ''
            ).trim()
        );

        if (!artist || !track) {
            return res.status(400).json({
                error:
                    'missing_parameters',

                message:
                    'Informe artist e track.'
            });
        }

        const cacheKey =
            `${normalizeText(artist)}::${normalizeText(track)}`;

        // ====================================================
        // CACHE
        // ====================================================

        const cached =
            getSongCache(
                cacheKey
            );

        if (cached) {
            console.log(
                `⚡ CACHE: ${artist} - ${track}`
            );

            return res
                .status(200)
                .json(cached);
        }

        // ====================================================
        // EVITAR BUSCAS DUPLICADAS
        // ====================================================

        if (
            inFlight.has(cacheKey)
        ) {
            try {
                const result =
                    await inFlight.get(
                        cacheKey
                    );

                return res
                    .status(200)
                    .json(result);
            } catch (error) {
                return res
                    .status(
                        error.statusCode ||
                            500
                    )
                    .json({
                        error:
                            error.code ||
                            'server_error',

                        message:
                            error.message
                    });
            }
        }

        // ====================================================
        // EXECUTAR BUSCA
        // ====================================================

        const promise =
            (async () => {
                const result =
                    await findSong(
                        artist,
                        track
                    );

                const response = {
                    title:
                        result.title ||
                        track,

                    artist:
                        result.artist ||
                        artist,

                    originalKey:
                        result.originalKey ||
                        '',

                    shapeKey:
                        result.shapeKey ||
                        '',

                    capo:
                        result.capo ||
                        '',

                    content:
                        result.content,

                    url:
                        result.url,

                    source:
                        result.source,

                    // útil para debug
                    searchScore:
                        Math.round(
                            result.score
                        )
                };

                saveSongCache(
                    cacheKey,
                    response
                );

                return response;
            })();

        inFlight.set(
            cacheKey,
            promise
        );

        try {
            const result =
                await promise;

            console.log('');
            console.log(
                '══════════════════════════════════════'
            );

            console.log(
                '✅ CIFRA ENCONTRADA'
            );

            console.log(
                `🎵 ${result.title}`
            );

            console.log(
                `🎤 ${result.artist}`
            );

            console.log(
                `🎼 Tom: ${
                    result.originalKey ||
                    'não identificado'
                }`
            );

            console.log(
                `🎸 Forma: ${
                    result.shapeKey ||
                    'não identificada'
                }`
            );

            console.log(
                `🪕 Capo: ${
                    result.capo
                        ? result.capo + 'ª casa'
                        : 'sem capo'
                }`
            );

            console.log(
                `🎯 Score: ${result.searchScore}`
            );

            console.log(
                `🔗 ${result.url}`
            );

            console.log(
                '══════════════════════════════════════'
            );

            return res
                .status(200)
                .json(result);

        } catch (error) {
            console.log('');
            console.log(
                '══════════════════════════════════════'
            );

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

            console.log(
                '══════════════════════════════════════'
            );

            return res
                .status(
                    error.statusCode ||
                        500
                )
                .json({
                    error:
                        error.code ||
                        'server_error',

                    message:
                        error.message
                });
        } finally {
            inFlight.delete(
                cacheKey
            );
        }
    }
);

// ============================================================
// SERVER
// ============================================================

app.listen(
    port,
    () => {
        console.log(
            `🚀 Cifra Band API V5-Intelligent rodando na porta ${port}`
        );
    }
);