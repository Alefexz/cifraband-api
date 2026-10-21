const cheerio = require('cheerio');
const {normalize} = require('./search-acceptance-normalize');

const BASE = 'https://www.losacordes.com';
function artistSlugs(artist) {
    const name = normalize(artist);
    return [...new Set([name, name.replace(/\be\b/g, ' ').replace(/\s+/g, ' ').trim()]
        .map(value => value.replace(/ /g, '-')))].filter(value => /^[a-z0-9][a-z0-9-]{0,199}$/.test(value));
}

function parseArtistCatalog(html, artist, slug) {
    if (typeof html !== 'string' || Buffer.byteLength(html) > 1500000) return [];
    const $ = cheerio.load(html);
    const identity = $('title').text().match(/^\s*(.+?)\s+acordes\s*\|\s*LosAcordes\.com\s*$/i);
    if (!identity || normalize(identity[1]) !== normalize(artist)) return [];
    const links = new Map();
    $('a[href]').each((_, element) => {
        if (links.size >= 800) return;
        try {
            const url = new URL($(element).attr('href'), BASE);
            const parts = url.pathname.split('/').filter(Boolean);
            if (url.origin !== BASE || url.username || url.password || url.search || url.hash ||
                parts.length !== 3 || parts[0] !== 'acordes' || parts[1] !== slug ||
                !/^[a-z0-9][a-z0-9-]{0,299}$/i.test(parts[2])) return;
            const title = $(element).text().replace(/\s+/g, ' ').trim();
            if (!title || title.length > 300) return;
            links.set(url.href, {url: url.href, title, artist: identity[1].trim()});
        } catch { /* Ignore malformed links in external HTML. */ }
    });
    return [...links.values()];
}

function createArtistCatalogDiscovery({get, index, onAttempt = () => {}, onFailure = () => {},
    blocked = () => false, now = Date.now, ttl = 6 * 3600000, maxEntries = 200}) {
    const memory = new Map();
    return async function discover(artist) {
        const key = normalize(artist);
        const prior = memory.get(key);
        if (prior && now() - prior.at < ttl) return prior.links;
        let refreshed = false;
        // Only full-name slug variants, never a first-name-only artist guess.
        const groups = await Promise.all(artistSlugs(artist).map(async slug => {
            const cacheKey = `los_acordes:${slug}`;
            const saved = await index?.artist(cacheKey);
            const validSaved = (saved?.links || []).filter(item => normalize(item.artist) === key);
            if (validSaved.length && !saved.stale) { refreshed = true; return validSaved; }
            const url = `${BASE}/${slug}`;
            if (blocked(url)) return validSaved;
            const started = now();
            try {
                const response = await get(url, {timeout: 1800, signal: AbortSignal.timeout(1800),
                    responseEncoding: 'latin1', maxContentLength: 1500000, maxRedirects: 0});
                onAttempt(url, response.status, now() - started, response.headers, 'artist_catalog');
                const links = response.status === 200 ? parseArtistCatalog(response.data, artist, slug) : [];
                if (links.length) {
                    refreshed = true;
                    void Promise.resolve(index?.rememberArtist(cacheKey, links)).catch(() => {});
                    return links;
                }
            } catch (error) { onFailure(url, error, now() - started); }
            return validSaved;
        }));
        const links = [...new Map(groups.flat().map(item => [item.url, item])).values()];
        if (links.length && refreshed) {
            memory.delete(key); memory.set(key, {at: now(), links});
            while (memory.size > maxEntries) memory.delete(memory.keys().next().value);
        }
        return links;
    };
}

module.exports = {artistSlugs, parseArtistCatalog, createArtistCatalogDiscovery};
