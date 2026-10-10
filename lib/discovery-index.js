const {createHash} = require('node:crypto');
const {normalize} = require('./catalog-search');

const idFor = key => createHash('sha256').update(key).digest('hex');
const songKey = (artist, title) => `song:${normalize(artist)}:${normalize(title)}`;
const artistKey = slug => `artist:${slug}`;
const HOSTS = new Set(['www.cifraclub.com.br', 'cifraclub.com.br', 'www.losacordes.com',
    'losacordes.com', 'www.cifras.com.br', 'cifras.com.br', 'cifrasgospel.online', 'www.cifrasgospel.online']);

function safeSourceUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port ||
            url.pathname.length > 1000 || /(?:^|\/)(?:letra|letras|partituras|discografia|tabs-[^/]+)(?:\/|$)/i.test(url.pathname)) return '';
        url.search = ''; url.hash = '';
        return url.toString();
    } catch { return ''; }
}

async function bounded(action, ms, fallback) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(action),
            new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]);
    } catch { return fallback; }
    finally { clearTimeout(timer); }
}

function cleanLinks(links) {
    const unique = new Map();
    for (const item of links || []) {
        const url = safeSourceUrl(item.url);
        if (!url || typeof item.title !== 'string' || !item.title.trim()) continue;
        const prior = unique.get(url);
        if (prior?.verified && !item.verified) continue;
        unique.set(url, {url, title: item.title.trim().slice(0, 300),
            artist: String(item.artist || prior?.artist || '').slice(0, 200),
            verified: Boolean(item.verified || prior?.verified)});
    }
    // Metadata only; bounded below Firestore's document limit.
    let bytes = 0;
    return [...unique.values()].sort((a, b) => Number(b.verified) - Number(a.verified)).slice(0, 800)
        .filter(item => { bytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + 100; return bytes < 700000; });
}

function createDiscoveryIndex({store, now = Date.now, ttl = 6 * 3600000, readTimeout = 250,
    writeTimeout = 10000, maxEntries = 500}) {
    const memory = new Map(), pending = new Map(), writes = new Map();
    function keep(key, value) {
        memory.delete(key); memory.set(key, value);
        while (memory.size > maxEntries) memory.delete(memory.keys().next().value);
        return value;
    }
    async function read(key) {
        const cached = memory.get(key);
        if (cached) return cached;
        if (!pending.has(key)) {
            if (pending.size >= maxEntries) return null;
            const task = Promise.resolve().then(() => store.read(key)).then(value => {
                if (!value) return null;
                const links = cleanLinks(value.links);
                if (!links.length) return null;
                return keep(key, {links, checkedAt: Number(value.checkedAt) || 0});
            }).catch(() => null).finally(() => pending.delete(key));
            pending.set(key, task);
        }
        return bounded(() => pending.get(key), readTimeout, null);
    }
    async function merge(key, links) {
        const clean = cleanLinks(links);
        if (!clean.length) return; // Never replace a usable index with a failed/empty fetch.
        const value = {links: cleanLinks([...(memory.get(key)?.links || []), ...clean]), checkedAt: now()};
        keep(key, value);
        // Coalesce concurrent writes to the same artist; flush any links learned meanwhile.
        if (writes.has(key)) return writes.get(key);
        const task = (async () => {
            let saved;
            do {
                saved = memory.get(key);
                await bounded(() => store.merge(key, saved), writeTimeout, null);
            } while (memory.has(key) && memory.get(key) !== saved);
        })().finally(() => writes.delete(key));
        writes.set(key, task);
        await task;
    }
    return {
        async known(artist, title) { return (await read(songKey(artist, title)))?.links || []; },
        async artist(slug) {
            const result = await read(artistKey(slug));
            return result ? {...result, stale: now() - result.checkedAt >= ttl} : null;
        },
        rememberArtist(slug, links) { return merge(artistKey(slug), links); },
        rememberSong(artist, title, result) {
            return merge(songKey(artist, title), [{url: result.url, title: result.title,
                artist: result.artist, verified: true}]);
        },
    };
}

function firestoreDiscoveryStore(getDb) {
    return {
        async read(key) {
            return (await getDb().collection('chord_discovery').doc(idFor(key)).get()).data() || null;
        },
        async merge(key, value) {
            const db = getDb(), ref = db.collection('chord_discovery').doc(idFor(key));
            await db.runTransaction(async tx => {
                const current = (await tx.get(ref)).data();
                tx.set(ref, {key, checkedAt: value.checkedAt,
                    links: cleanLinks([...(current?.links || []), ...value.links])});
            });
        },
        async documents() {
            const db = getDb(), documents = [];
            let cursor;
            do {
                let query = db.collection('chord_discovery').orderBy('__name__').limit(200);
                if (cursor) query = query.startAfter(cursor);
                const page = await query.get();
                for (const doc of page.docs) {
                    const data = doc.data();
                    for (const link of cleanLinks(data.links)) {
                        if (!link.artist) continue;
                        documents.push({id: `link:${idFor(link.url)}`, ...link, metadataOnly: true});
                    }
                }
                cursor = page.size === 200 ? page.docs.at(-1) : null;
            } while (cursor);
            return documents;
        },
    };
}

module.exports = {createDiscoveryIndex, firestoreDiscoveryStore, safeSourceUrl, cleanLinks, bounded};
