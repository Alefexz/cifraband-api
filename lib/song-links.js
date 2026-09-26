const axios = require('axios');
const cheerio = require('cheerio');
const {catalogTitle} = require('./song-title');

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const phrase = (text, wanted) => (` ${normalize(text)} `).includes(` ${normalize(wanted)} `);
const cleanTitle = value => normalize(catalogTitle(value)).replace(/\b(ao vivo|live|official video|video oficial|official audio|audio oficial|lyric video)\b/g, '').replace(/\s+/g, ' ').trim();

function matches(title, artist, metadata, platform) {
    if (!normalize(title) || !normalize(artist)) return false;
    if (/\b(cover|karaoke|playback|tutorial|reaction|shorts)\b/.test(normalize(metadata.title))) return false;
    if (platform === 'spotify') {
        return cleanTitle(metadata.title) === cleanTitle(title) &&
            (metadata.artists || []).some(name => normalize(name) === normalize(artist));
    }
    return phrase(metadata.title, cleanTitle(title)) &&
        (phrase(metadata.author, artist) || phrase(metadata.title, artist));
}

function canonical(platform, value) {
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
        if (platform === 'spotify' && u.hostname === 'open.spotify.com') {
            const id = u.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})\/?$/)?.[1];
            return id ? `https://open.spotify.com/track/${id}` : null;
        }
        if (platform === 'youtube' && ['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be'].includes(u.hostname)) {
            const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.pathname === '/watch' ? u.searchParams.get('v') : null;
            return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : null;
        }
    } catch (_) { /* Invalid external candidate is never fetched. */ }
    return null;
}

function createSongLinks({get = axios.get, post = axios.post, now = Date.now, env = process.env} = {}) {
    const cache = new Map();
    const running = new Map();
    let spotifyToken;
    const request = (url, params, signal) => get(url, {
        params, signal, timeout: 7000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024,
        headers: {'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'pt-BR,pt;q=0.9'},
    });

    async function search(platform, title, artist, signal) {
        if (platform === 'youtube') {
            try {
                const response = await request('https://www.youtube.com/results', {search_query: `${title} ${artist}`}, signal);
                const $ = cheerio.load(response.data);
                const script = $('script').toArray().map(el => $(el).html() || '')
                    .find(text => text.trim().startsWith('var ytInitialData = '));
                if (script) {
                    const data = JSON.parse(script.trim().replace(/^var ytInitialData =\s*/, '').replace(/;\s*$/, ''));
                    const candidates = [];
                    const visit = node => {
                        if (!node || typeof node !== 'object') return;
                        if (node.videoRenderer) {
                            const video = node.videoRenderer;
                            const metadata = {
                                title: (video.title?.runs || []).map(r => r.text || '').join(''),
                                author: (video.ownerText?.runs || []).map(r => r.text || '').join(''),
                            };
                            const url = canonical('youtube', `https://www.youtube.com/watch?v=${video.videoId}`);
                            if (url && matches(title, artist, metadata, platform)) candidates.push(url);
                            return;
                        }
                        for (const child of Object.values(node)) visit(child);
                    };
                    visit(data.contents);
                    if (candidates.length) return [...new Set(candidates)].slice(0, 4);
                }
            } catch (_) { /* Public search can be unavailable; try the independent index. */ }
        }
        const site = platform === 'youtube' ? 'youtube.com/watch' : 'open.spotify.com/track';
        const response = await request('https://www.bing.com/search', {q: `site:${site} ${title} ${artist}`}, signal);
        const $ = cheerio.load(response.data);
        const urls = new Set();
        $('a[href]').each((_, el) => {
            let href = $(el).attr('href');
            try {
                const redirect = new URL(href);
                if (redirect.hostname === 'www.bing.com' && redirect.pathname === '/ck/a') {
                    const encoded = redirect.searchParams.get('u') || '';
                    if (encoded.startsWith('a1')) href = Buffer.from(encoded.slice(2), 'base64').toString();
                }
            } catch (_) { return; }
            const url = canonical(platform, href);
            if (url) urls.add(url);
        });
        return [...urls].slice(0, 4);
    }

    async function spotifySearch(title, artist, signal) {
        if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
        if (!spotifyToken || spotifyToken.until <= now()) {
            const {data} = await post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
                signal, timeout: 7000, maxRedirects: 0,
                auth: {username: env.SPOTIFY_CLIENT_ID, password: env.SPOTIFY_CLIENT_SECRET},
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            });
            spotifyToken = {value: data.access_token, until: now() + Math.max(0, data.expires_in - 60) * 1000};
        }
        const {data} = await get('https://api.spotify.com/v1/search', {
            signal, timeout: 7000, maxRedirects: 0,
            headers: {Authorization: `Bearer ${spotifyToken.value}`},
            params: {q: `track:${title} artist:${artist}`, type: 'track', market: 'BR', limit: 10},
        });
        for (const track of data.tracks?.items || []) {
            const info = {title: track.name, artists: track.artists?.map(a => a.name) || []};
            const url = canonical('spotify', track.external_urls?.spotify);
            if (url && matches(title, artist, info, 'spotify')) return {status: 'found', url, title: track.name};
        }
        return {status: 'unconfirmed'};
    }

    async function metadata(platform, url, signal) {
        if (platform === 'youtube') {
            const {data} = await request('https://www.youtube.com/oembed', {url, format: 'json'}, signal);
            return {title: data.title, author: data.author_name};
        }
        const id = new URL(url).pathname.split('/').at(-1);
        const response = await request(`https://open.spotify.com/embed/track/${id}`, {}, signal);
        const $ = cheerio.load(response.data);
        const entity = JSON.parse($('#__NEXT_DATA__').text()).props?.pageProps?.state?.data?.entity;
        if (entity?.type !== 'track' || entity.id !== id) throw new Error('invalid_track_metadata');
        return {title: entity.title || entity.name, artists: entity.artists?.map(a => a.name) || []};
    }

    async function resolve(platform, title, artist) {
        if (!['youtube', 'spotify'].includes(platform)) throw new Error('invalid_platform');
        title = catalogTitle(title);
        const key = JSON.stringify([platform, normalize(title), normalize(artist)]);
        const saved = cache.get(key);
        if (saved && saved.until > now()) return saved.result;
        if (running.has(key)) return running.get(key);
        if (running.size >= 4) return {status: 'unavailable'};
        const work = (async () => {
            const signal = AbortSignal.timeout(22000);
            let failed = false;
            try {
                if (platform === 'spotify') {
                    const official = await spotifySearch(title, artist, signal);
                    if (official) {
                        if (official.status === 'found') {
                            if (cache.size >= 300) cache.delete(cache.keys().next().value);
                            cache.set(key, {until: now() + 6 * 60 * 60 * 1000, result: official});
                        }
                        return official;
                    }
                }
                const urls = await search(platform, title, artist, signal);
                for (const url of urls) {
                    try {
                        const data = await metadata(platform, url, signal);
                        if (matches(title, artist, data, platform)) {
                            const result = {status: 'found', url, title: data.title};
                            if (cache.size >= 300) cache.delete(cache.keys().next().value);
                            cache.set(key, {until: now() + 6 * 60 * 60 * 1000, result});
                            return result;
                        }
                    } catch (_) { failed = true; }
                }
                // No result is not proof that a recording does not exist.
                return {status: platform === 'spotify' ? 'configuration_required' : failed || !urls.length ? 'unavailable' : 'unconfirmed'};
            } catch (_) { return {status: 'unavailable'}; }
        })();
        running.set(key, work);
        try { return await work; } finally { running.delete(key); }
    }
    return {resolve};
}
module.exports = {createSongLinks, matches, canonical};
