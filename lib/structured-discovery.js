const {normalize} = require('./search-acceptance-normalize');

const ENDPOINT = 'https://solr.sscdn.co/cc/h2/';
const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,299}$/i.test(value);
function hymnNumber(artist, title) {
    if (normalize(artist) !== 'harpa crista') return null;
    const match = normalize(title).match(/^(?:(?:hino|hc|harpa|harpa crista) )?(\d{1,3})$/);
    const number = match ? Number(match[1]) : 0;
    return number >= 1 && number <= 640 ? number : null;
}
function numberedHymnMatch(artist, requested, found) {
    const number = hymnNumber(artist, requested);
    if (!number) return false;
    const numbers = (normalize(found).match(/\b\d{1,3}\b/g) || []).map(Number);
    return numbers.length === 1 && numbers[0] === number;
}
function parseDiscovery(text) {
    if (typeof text !== 'string' || text.length > 500000) throw Error('Invalid discovery payload');
    const trimmed = text.trim();
    const json = trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1) : trimmed;
    const response = JSON.parse(json).response;
    if (!response || !Array.isArray(response.docs)) throw Error('Invalid discovery schema');
    return response.docs.slice(0, 40).filter(hit => String(hit.t) === '2' && slug(hit.d) && slug(hit.u) &&
        typeof hit.a === 'string' && hit.a.length <= 200 && typeof hit.m === 'string' && hit.m.length <= 500)
        .map(hit => ({artist: hit.a, title: hit.m,
            url: `https://www.cifraclub.com.br/${hit.d}/${hit.u}/`}));
}
function discoveryQueries(artist, track) {
    const number = hymnNumber(artist, track);
    const exact = `${artist} ${number || track}`.trim().slice(0, 600);
    // Shorten catalogue decoration only for discovery; acceptance still uses the full request.
    const short = String(track).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
        .replace(/^\s*(?:medley|pot[- ]?pourri)\s*[-:]?\s*/i, '').replace(/\s+/g, ' ').trim();
    return [...new Set([exact, `${artist} ${short}`.trim().slice(0, 600)])].filter(Boolean);
}
function createStructuredDiscovery({get, onAttempt = () => {}, onFailure = () => {}, now = Date.now,
    ttl = 600000, maxEntries = 200}) {
    const cache = new Map();
    return async function discover(artist, track) {
        const key = `${normalize(artist)}::${normalize(track)}`;
        const cached = cache.get(key);
        if (cached && now() - cached.at < ttl) return cached.hits;
        const hits = new Map();
        const number = hymnNumber(artist, track);
        for (const query of discoveryQueries(artist, track)) {
            const started = now();
            try {
                const response = await get(ENDPOINT, {params: {q: query}, timeout: 1600,
                    maxContentLength: 500000, maxRedirects: 0, responseType: 'text',
                    headers: {Accept: 'application/json,text/plain'}});
                onAttempt(ENDPOINT, response.status, now() - started, response.headers, 'structured_discovery');
                for (const hit of parseDiscovery(response.data)) {
                    if (normalize(hit.artist) !== normalize(artist)) continue;
                    if (number && !numberedHymnMatch(artist, track, hit.title)) continue;
                    hits.set(hit.url, hit);
                }
                if (hits.size) break;
            } catch (error) {
                onFailure(ENDPOINT, error, now() - started);
                if ([403, 429].includes(error.response?.status) || error.code === 'ERR_CANCELED') break;
            }
        }
        const results = [...hits.values()].slice(0, 8);
        if (results.length) {
            cache.delete(key); cache.set(key, {at: now(), hits: results});
            while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        }
        return results;
    };
}
module.exports = {createStructuredDiscovery, parseDiscovery, discoveryQueries, hymnNumber, numberedHymnMatch};
