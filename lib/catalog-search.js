const MiniSearch = require('minisearch');
const { analyzeChordContent, extractLyricText } = require('./chord-content');
const {createQueryCorrector} = require('./query-correction');

const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bminha? alma\b/g, 'minhalma').replace(/\bpor que\b/g, 'porque').trim();
const stop = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'pra', 'para', 'hino', 'hc']);
const terms = text => normalize(text).split(' ').filter(t => t && !stop.has(t));
const fuzzy = term => /^\d+$/.test(term) || term.length < 4 ? false : term.length < 8 ? 1 : 2;

function buildCatalog(documents) {
    const lyrics = new Map();
    const index = new MiniSearch({ fields: ['title', 'artist', 'lyrics'], storeFields: ['title', 'artist', 'url', 'metadataOnly'],
        tokenize: terms, processTerm: term => term });
    const unique = new Map(documents.map(doc => [doc.id, doc]));
    const records = [...unique.values()].filter(doc => doc.id && doc.title && doc.artist &&
        (doc.metadataOnly === true || analyzeChordContent(doc.content).usable))
        .map(doc => {
            const text = normalize(extractLyricText(String(doc.content || '').slice(0, 40000)));
            lyrics.set(doc.id, text);
            return { id: doc.id, title: doc.title, artist: doc.artist, url: doc.url || '', lyrics: text,
                metadataOnly: doc.metadataOnly === true };
        });
    index.addAll(records);
    const correct = createQueryCorrector(records);
    function search(query) {
        const q = normalize(query);
        const words = terms(q);
        if (!words.length) return [];
        const options = { combineWith: 'AND', boost: { title: 8, artist: 5, lyrics: 0.3 }, prefix: false };
        const exact = index.search(q, { ...options, fuzzy: false });
        const approximate = exact.length < 10 ? index.search(q, {
            ...options, fields: ['title', 'artist'], fuzzy,
            // Complete only the final word; never expand hymn numbers.
            prefix: (term, i, tokens) => i === tokens.length - 1 && term.length >= 4 && !/^\d+$/.test(term),
        }) : [];
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
        }).sort((a, b) => {
            const priority = hit => normalize(hit.title) === q ? 3
                : normalize(hit.artist) === q ? 2 : hit.catalogMatch === 'metadata' ? 1 : 0;
            return priority(b) - priority(a) || b.score - a.score;
        }).slice(0, 30).map(hit => ({
            trackName: hit.title, artistName: hit.artist, cacheId: hit.id, sourceUrl: hit.url,
            catalogMatch: hit.catalogMatch, matchedQuery: q,
            provider: hit.metadataOnly ? 'discovery_index' : 'global_cache',
        }));
    }
    return { search, correct, size: records.length };
}

function createCatalogSearch({ load, rerank = async (_, hits) => hits, now = Date.now, ttl = 60 * 60 * 1000, loadTimeout = 10000 }) {
    let catalog, loadedAt = 0, pending, retryAt = 0;
    async function refresh() {
        if (!pending) pending = (async () => {
            let timer;
            try {
                const documents = await Promise.race([
                    Promise.resolve().then(load),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(Error('catalog_load_timeout')), loadTimeout);
                    }),
                ]);
                catalog = buildCatalog(documents);
                loadedAt = now();
                retryAt = 0;
            } catch (error) {
                retryAt = now() + 60000;
                throw error;
            } finally {
                clearTimeout(timer);
            }
        })().finally(() => { pending = null; });
        return pending;
    }
    return async query => {
        if (!catalog && now() >= retryAt) {
            await refresh();
        } else if (catalog && now() - loadedAt >= ttl && now() >= retryAt) {
            // Stale-while-revalidate: keep search responsive during a DB refresh.
            void refresh().catch(() => {});
        }
        if (!catalog) throw Error('catalog_unavailable');
        const stale = now() - loadedAt >= ttl;
        let results = catalog.search(query);
        const correctedQuery = results.length ? null : catalog.correct(query);
        if (correctedQuery) results = catalog.search(correctedQuery);
        const seen = new Set();
        results = results.filter(item => {
            const key = `${normalize(item.artistName)}:${normalize(item.trackName)}`;
            if (seen.has(key)) return false;
            seen.add(key); return true;
        });
        results = await rerank(correctedQuery || query, results, {
            exact: item => normalize(item.trackName) === normalize(query) || normalize(item.artistName) === normalize(query),
        });
        if (correctedQuery) results = results.map(item => ({...item, correctionOf: query, correctedQuery}));
        return { results, correctedQuery, indexedCount: catalog.size, stale };
    };
}

module.exports = { buildCatalog, createCatalogSearch, normalize };
