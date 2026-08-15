// cifra_band/functions/server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| CONFIGURAÇÕES
|--------------------------------------------------------------------------
*/

const CACHE_TTL = 30 * 60 * 1000; // 30 minutos
const MAX_CACHE_ITEMS = 200;
const REQUEST_TIMEOUT = 8000;

/*
|--------------------------------------------------------------------------
| CACHE EM MEMÓRIA
|--------------------------------------------------------------------------
|
| Mantemos o cache em RAM para deixar buscas repetidas praticamente
| instantâneas.
|
*/

const cache = new Map();

/*
|--------------------------------------------------------------------------
| REQUISIÇÕES EM ANDAMENTO
|--------------------------------------------------------------------------
|
| Se 5 músicos procurarem a mesma música ao mesmo tempo,
| fazemos apenas UMA requisição ao Cifra Club.
|
*/

const inFlight = new Map();

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'Cifra Band API',
        version: 'V3-Lite',
        timestamp: new Date().toISOString()
    });
});

/*
|--------------------------------------------------------------------------
| SLUG
|--------------------------------------------------------------------------
*/

function formatSlug(text) {
    return String(text)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, 'e')
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
        .replace(/\s+/g, '-');
}

/*
|--------------------------------------------------------------------------
| LIMPA CACHE EXPIRADO
|--------------------------------------------------------------------------
*/

function cleanExpiredCache() {
    const now = Date.now();

    for (const [key, value] of cache.entries()) {
        if (now - value.createdAt > CACHE_TTL) {
            cache.delete(key);
        }
    }

    // Proteção contra crescimento infinito
    while (cache.size > MAX_CACHE_ITEMS) {
        const firstKey = cache.keys().next().value;

        if (firstKey) {
            cache.delete(firstKey);
        } else {
            break;
        }
    }
}

/*
|--------------------------------------------------------------------------
| SALVAR CACHE
|--------------------------------------------------------------------------
*/

function saveCache(key, data) {
    cleanExpiredCache();

    cache.set(key, {
        data,
        createdAt: Date.now()
    });
}

/*
|--------------------------------------------------------------------------
| LER CACHE
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| EXTRAÇÃO DO TOM / FORMA / CAPOTRASTE
|--------------------------------------------------------------------------
|
| O Cifra Club atualmente apresenta algo como:
|
| Tom: Bb (com forma de G)
| Capotraste: 3ª casa
|
| Exatamente o caso da música "É Ele".
|
*/

function extractKeyInfo($) {
    let originalKey = '';
    let shapeKey = '';
    let capo = '';

    /*
    |--------------------------------------------------------------------------
    | Primeiro tentamos o texto específico da página
    |--------------------------------------------------------------------------
    */

    const bodyText = $('body').text()
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

    /*
    |--------------------------------------------------------------------------
    | TOM
    |--------------------------------------------------------------------------
    |
    | Exemplos:
    |
    | Tom: Bb
    | Tom: C
    | Tom: F#
    | Tom: Eb (com forma de C)
    |
    */

    const keyMatch = bodyText.match(
        /Tom:\s*([A-G](?:#|b)?)(?:\s*\(\s*com\s+forma\s+de\s*([A-G](?:#|b)?)\s*\))?/i
    );

    if (keyMatch) {
        originalKey = keyMatch[1].trim();

        if (keyMatch[2]) {
            shapeKey = keyMatch[2].trim();
        }
    }

    /*
    |--------------------------------------------------------------------------
    | CAPOTRASTE
    |--------------------------------------------------------------------------
    |
    | Exemplos:
    |
    | Capotraste: 3ª casa
    | Capotraste: 2a casa
    | Capotraste: 4º casa
    |
    */

    const capoMatch = bodyText.match(
        /Capotraste:\s*(\d+)\s*(?:ª|a|º|°)?\s*casa/i
    );

    if (capoMatch) {
        capo = capoMatch[1];
    }

    /*
    |--------------------------------------------------------------------------
    | FALLBACK PARA FORMA
    |--------------------------------------------------------------------------
    |
    | Caso o formato do texto mude, tentamos encontrar:
    |
    | "forma dos acordes no tom de X"
    | "forma de X"
    |
    */

    if (!shapeKey) {
        const shapeMatch = bodyText.match(
            /forma(?:\s+dos\s+acordes)?\s+(?:no\s+tom\s+de|de)\s*([A-G](?:#|b)?)/i
        );

        if (shapeMatch) {
            shapeKey = shapeMatch[1].trim();
        }
    }

    /*
    |--------------------------------------------------------------------------
    | FALLBACK FINAL
    |--------------------------------------------------------------------------
    |
    | Se não existe capotraste/forma explícita,
    | a forma utilizada é o próprio tom.
    |
    */

    if (!shapeKey && originalKey) {
        shapeKey = originalKey;
    }

    return {
        originalKey,
        shapeKey,
        capo
    };
}

/*
|--------------------------------------------------------------------------
| LIMPEZA DA CIFRA
|--------------------------------------------------------------------------
*/

function cleanSongContent(content) {
    return content
        .replace(/\[\/?(b|i)\]/g, '')
        .replace(/\r/g, '')
        .split('\n')
        .filter(line => line.trim() !== '')
        .join('\n')
        .trim();
}

/*
|--------------------------------------------------------------------------
| BUSCAR CIFRA
|--------------------------------------------------------------------------
*/

app.get('/searchSong', async (req, res) => {
    const artist = String(req.query.artist || '').trim();
    const track = String(req.query.track || '').trim();

    /*
    |--------------------------------------------------------------------------
    | VALIDAÇÃO
    |--------------------------------------------------------------------------
    */

    if (!artist || !track) {
        return res.status(400).json({
            error: 'missing_parameters',
            message: 'Informe artist e track.'
        });
    }

    /*
    |--------------------------------------------------------------------------
    | CACHE KEY
    |--------------------------------------------------------------------------
    */

    const artistSlug = formatSlug(artist);
    const trackSlug = formatSlug(track);

    const cacheKey = `${artistSlug}-${trackSlug}`;

    /*
    |--------------------------------------------------------------------------
    | CACHE
    |--------------------------------------------------------------------------
    */

    const cached = getCache(cacheKey);

    if (cached) {
        console.log(`⚡ CACHE: ${artist} - ${track}`);

        return res.status(200).json(cached);
    }

    /*
    |--------------------------------------------------------------------------
    | EVITA DUPLICAR SCRAPING
    |--------------------------------------------------------------------------
    */

    if (inFlight.has(cacheKey)) {
        console.log(`⏳ Reutilizando requisição: ${track}`);

        try {
            const result = await inFlight.get(cacheKey);

            return res.status(200).json(result);
        } catch (error) {
            return res.status(
                error.statusCode || 500
            ).json({
                error: error.code || 'search_error',
                message: error.message || 'Erro ao buscar cifra.'
            });
        }
    }

    /*
    |--------------------------------------------------------------------------
    | URL DIRETA
    |--------------------------------------------------------------------------
    */

    const songUrl =
        `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}/`;

    console.log(`🔎 Buscando: ${artist} - ${track}`);
    console.log(`🌐 URL: ${songUrl}`);

    /*
    |--------------------------------------------------------------------------
    | PROMISE PRINCIPAL
    |--------------------------------------------------------------------------
    */

    const requestPromise = (async () => {
        try {
            /*
            |--------------------------------------------------------------------------
            | AXIOS
            |--------------------------------------------------------------------------
            */

            const songResponse = await axios.get(songUrl, {
                timeout: REQUEST_TIMEOUT,

                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',

                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',

                    'Accept-Language':
                        'pt-BR,pt;q=0.9,en;q=0.8'
                },

                validateStatus: status => {
                    return status >= 200 && status < 400;
                }
            });

            /*
            |--------------------------------------------------------------------------
            | CHEERIO
            |--------------------------------------------------------------------------
            */

            const $ = cheerio.load(songResponse.data);

            /*
            |--------------------------------------------------------------------------
            | CONTEÚDO DA CIFRA
            |--------------------------------------------------------------------------
            */

            const content = $('pre').first().text() || '';

            if (!content.trim()) {
                const error = new Error(
                    'A página foi encontrada, mas a cifra não foi localizada.'
                );

                error.code = 'SONG_CONTENT_NOT_FOUND';
                error.statusCode = 404;

                throw error;
            }

            /*
            |--------------------------------------------------------------------------
            | METADADOS
            |--------------------------------------------------------------------------
            */

            const keyInfo = extractKeyInfo($);

            /*
            |--------------------------------------------------------------------------
            | LIMPEZA
            |--------------------------------------------------------------------------
            */

            const cleanContent = cleanSongContent(content);

            /*
            |--------------------------------------------------------------------------
            | RESULTADO
            |--------------------------------------------------------------------------
            |
            | Mantemos os mesmos nomes que o Flutter já espera:
            |
            | originalKey
            | capo
            | shapeKey
            | content
            | url
            |
            */

            const finalResult = {
                title: track,
                artist: artist,

                // TOM MUSICAL REAL
                originalKey: keyInfo.originalKey,

                // FORMA DOS ACORDES
                shapeKey: keyInfo.shapeKey,

                // CAPOTRASTE
                capo: keyInfo.capo,

                // CIFRA
                content: cleanContent,

                // ORIGEM
                url: songUrl,
                source: 'cifraclub'
            };

            /*
            |--------------------------------------------------------------------------
            | AVISO DE SEGURANÇA
            |--------------------------------------------------------------------------
            |
            | A cifra pode ser encontrada mesmo se os metadados não forem.
            | Não bloqueamos a música por isso.
            |
            */

            if (!keyInfo.originalKey) {
                console.warn(
                    `⚠️ Tom não identificado: ${artist} - ${track}`
                );
            }

            /*
            |--------------------------------------------------------------------------
            | CACHE
            |--------------------------------------------------------------------------
            */

            saveCache(cacheKey, finalResult);

            console.log(
                `✅ OK: ${track} | Tom: ${keyInfo.originalKey || '?'} | ` +
                `Forma: ${keyInfo.shapeKey || '?'} | ` +
                `Capo: ${keyInfo.capo || '0'}`
            );

            return finalResult;

        } catch (error) {
            /*
            |--------------------------------------------------------------------------
            | TIMEOUT
            |--------------------------------------------------------------------------
            */

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

            /*
            |--------------------------------------------------------------------------
            | 404
            |--------------------------------------------------------------------------
            */

            if (error.response && error.response.status === 404) {
                const notFoundError = new Error(
                    'Cifra não encontrada. Verifique o nome da música e do artista.'
                );

                notFoundError.code = 'SONG_NOT_FOUND';
                notFoundError.statusCode = 404;

                throw notFoundError;
            }

            /*
            |--------------------------------------------------------------------------
            | ERRO DO SCRAPER
            |--------------------------------------------------------------------------
            */

            console.error(
                `❌ Erro em ${artist} - ${track}:`,
                error.message
            );

            if (error.statusCode) {
                throw error;
            }

            const scraperError = new Error(
                'Não foi possível buscar a cifra agora.'
            );

            scraperError.code = 'SCRAPER_ERROR';
            scraperError.statusCode = 502;

            throw scraperError;
        }
    })();

    /*
    |--------------------------------------------------------------------------
    | REGISTRA REQUISIÇÃO EM ANDAMENTO
    |--------------------------------------------------------------------------
    */

    inFlight.set(cacheKey, requestPromise);

    try {
        const result = await requestPromise;

        return res.status(200).json(result);

    } catch (error) {
        return res.status(
            error.statusCode || 500
        ).json({
            error: error.code || 'server_error',
            message: error.message || 'Erro interno do servidor.'
        });

    } finally {
        inFlight.delete(cacheKey);
    }
});

/*
|--------------------------------------------------------------------------
| ERROS DO EXPRESS
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {
    console.error('❌ Erro Express:', err);

    res.status(500).json({
        error: 'internal_server_error',
        message: 'Erro interno do servidor.'
    });
});

/*
|--------------------------------------------------------------------------
| SERVIDOR
|--------------------------------------------------------------------------
*/

app.listen(port, () => {
    console.log(
        `🚀 Cifra Band API V3-Lite rodando na porta ${port}`
    );
});