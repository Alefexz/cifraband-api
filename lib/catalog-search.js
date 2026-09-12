const MiniSearch = require('minisearch');
const { analyzeChordContent, extractLyricText } = require('./chord-content');

const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bminha? alma\b/g, 'minhalma').replace(/\bpor que\b/g, 'porque').trim();
const stop = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'pra', 'para', 'hino', 'hc']);
const terms = text => normalize(text).split(' ').filter(t => t && !stop.has(t));
const fuzzy = term => /^\d+$/.test(term) || term.length < 4 ? false : term.length < 8 ? 1 : 2;

function buildCatalog(documents) {
    const lyrics = new Map();
    const index = new MiniSearch({ fields: ['title', 'artist', 'lyrics'], storeFields: ['title', 'artist', 'url'],
        tokenize: terms, processTerm: term => term });
    const records = documents.filter(doc => doc.id && doc.title && doc.artist && analyzeChordContent(doc.content).usable)
        .map(doc => {
            const text = normalize(extractLyricText(String(doc.content).slice(0, 40000)));
            lyrics.set(doc.id, text);
            return { id: doc.id, title: doc.title, artist: doc.artist, url: doc.url || '', lyrics: text };
        });
    index.addAll(records);
    function search(query) {
        const q = normalize(query);
        const words = terms(q);
        if (!words.length) return [];
        const options = { combineWith: 'AND', boost: { title: 8, artist: 5, lyrics: 0.3 }, prefix: false };
        const exact = index.search(q, { ...options, fuzzy: false });
        const approximate = exact.length < 10 ? index.search(q, { ...options, fields: ['title', 'artist'], fuzzy }) : [];
        const seen = new Set();
        return [...exact, ...approximate].filter(hit => {
            if (seen.has(hit.id)) return false;
            const metadata = terms(`${hit.title} ${hit.artist}`);
            const numbers = words.filter(t => /^\d+$/.test(t));
            if (numbers.some(n => !metadata.includes(n))) return false;
            const metadataMatch = Object.values(hit.match).every(fields => fields.some(f => f !== 'lyrics'));
            const phrase = words.length >= 3 && lyrics.get(hit.id).includes(q);
            if (!metadataMatch && !phrase) return false;
            seen.add(hit.id);
            hit.catalogMatch = metadataMatch ? 'metadata' : 'lyrics';
            return true;
        }).slice(0, 30).map(hit => ({
            trackName: hit.title, artistName: hit.artist, cacheId: hit.id, sourceUrl: hit.url,
            catalogMatch: hit.catalogMatch, matchedQuery: q, provider: 'global_cache',
        }));
    }
    return { search, size: records.length };
}

function createCatalogSearch({ load, now = Date.now, ttl = 60 * 60 * 1000 }) {
    let catalog, loadedAt = 0, pending, retryAt = 0;
    async function refresh() {
        if (!pending) pending = (async () => {
            const documents = await load();
            catalog = buildCatalog(documents);
            loadedAt = now();
            retryAt = 0;
        })().finally(() => { pending = null; });
        return pending;
    }
    return async query => {
        let stale = Boolean(catalog && now() - loadedAt >= ttl);
        if ((!catalog || stale) && now() >= retryAt) {
            try { await refresh(); } catch (error) {
                retryAt = now() + 60000;
                if (!catalog) throw error;
                stale = true;
            }
        }
        if (!catalog) throw Error('catalog_unavailable');
        stale = now() - loadedAt >= ttl;
        return { results: catalog.search(query), indexedCount: catalog.size, stale };
    };
}

module.exports = { buildCatalog, createCatalogSearch, normalize };
