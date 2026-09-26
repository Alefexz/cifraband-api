const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSongLinks, matches, canonical} = require('./lib/song-links');
const {mountMemberActions} = require('./lib/member-actions');
const {catalogTitle} = require('./lib/song-title');
const {withSources, sourceFailure, sourceFailures} = require('./lib/source-diagnostics');
const {isSearchResultSafeForRequest} = require('./server');

test('truncated catalog medley keeps its name, without weakening A / B coverage', () => {
    const title = 'Medley - Corinhos de Fogo (Deus Forte Como Jeova / Divisa de Fogo / Desemb';
    assert.equal(catalogTitle(title), 'Medley - Corinhos de Fogo');
    assert.equal(catalogTitle('Ruja o Leao / Talita Cumi'), 'Ruja o Leao / Talita Cumi');
    assert.equal(matches(title, 'Midian Lima', {title: 'Midian Lima - Medley Corinhos de Fogo (Ao Vivo)', author: 'MK Music'}, 'youtube'), true);
    assert.equal(matches(title, 'Midian Lima', {title: 'Midian Lima - Divisa de Fogo', author: 'MK Music'}, 'youtube'), false);
    const content = 'C G Am F\nUma letra para testar\nOutra frase para cantar';
    assert.equal(isSearchResultSafeForRequest('Midian Lima', title, {title: 'Corinhos de Fogo', content}), true);
    assert.equal(isSearchResultSafeForRequest('FHOP', 'Ruja o Leao / Talita Cumi', {title: 'Ruja o Leao', content}), false);
});

test('source failures distinguish access errors and remain isolated by lookup', async () => {
    await withSources(async () => {
        sourceFailure('https://www.cifraclub.com.br/a/b/', {response: {status: 403}});
        sourceFailure('https://www.cifraclub.com.br/a/c/', {response: {status: 404}});
        assert.deepEqual(sourceFailures(), [{host: 'www.cifraclub.com.br', status: 403, attempts: 1}]);
        await withSources(async () => assert.deepEqual(sourceFailures(), []));
        assert.equal(sourceFailures().length, 1);
    });
    assert.deepEqual(sourceFailures(), []);
});

test('provider identity validation rejects covers, wrong artist, albums and malicious URLs', () => {
    assert.equal(matches('Ah Jesus', 'Julliany Souza', {title: 'Julliany Souza - Ah Jesus (Ao Vivo)', author: 'Julliany Souza'}, 'youtube'), true);
    assert.equal(matches('Ah Jesus', 'Julliany Souza', {title: 'Ah Jesus', author: 'Outro'}, 'youtube'), false);
    assert.equal(matches('Ah Jesus', 'Julliany Souza', {title: 'Ah Jesus cover Julliany Souza', author: 'Outro'}, 'youtube'), false);
    assert.equal(matches('Ah Jesus', 'Julliany Souza', {title: 'Ah Jesus', artists: ['Outra']}, 'spotify'), false);
    for (const u of ['https://open.spotify.com/album/4adUUVskCSWSoRAPcpAVYm', 'https://open.spotify.com.evil.test/track/4adUUVskCSWSoRAPcpAVYm', 'http://open.spotify.com/track/4adUUVskCSWSoRAPcpAVYm']) assert.equal(canonical('spotify', u), null);
});

test('YouTube verifies oEmbed metadata, shares pending lookups and caches matched links', async () => {
    let calls = 0;
    const resolver = createSongLinks({env: {}, get: async url => {
        calls++;
        if (url.includes('/results')) return {data: '<script>var ytInitialData = {"contents":{"videoRenderer":{"videoId":"ldK43s9UyQI","title":{"runs":[{"text":"Julliany Souza - Ah Jesus"}]},"ownerText":{"runs":[{"text":"Julliany Souza"}]}}}};</script>'};
        if (url.includes('bing.com')) return {data: '<a href="https://www.youtube.com/watch?v=ldK43s9UyQI">Misleading search title</a>'};
        return {data: {title: 'Julliany Souza - Ah Jesus', author_name: 'Julliany Souza'}};
    }});
    const first = resolver.resolve('youtube', 'Ah Jesus', 'Julliany Souza');
    assert.deepEqual(await resolver.resolve('youtube', 'Ah Jesus', 'Julliany Souza'), await first);
    assert.equal((await first).status, 'found');
    await resolver.resolve('youtube', 'Ah Jesus', 'Julliany Souza');
    assert.equal(calls, 2);
});

test('Spotify credentials stay server-side and only matching tracks are returned', async () => {
    const resolver = createSongLinks({env: {SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret'},
        post: async (url, body, config) => {
            assert.equal(url, 'https://accounts.spotify.com/api/token');
            assert.equal(config.auth.password, 'secret');
            return {data: {access_token: 'token', expires_in: 3600}};
        },
        get: async (url, config) => {
            assert.equal(url, 'https://api.spotify.com/v1/search');
            assert.equal(config.headers.Authorization, 'Bearer token');
            const external_urls = {spotify: 'https://open.spotify.com/track/4adUUVskCSWSoRAPcpAVYm'};
            return {data: {tracks: {items: [
                {name: 'Ah Jesus', artists: [{name: 'Outro'}], external_urls},
                {name: 'Ah Jesus', artists: [{name: 'Julliany Souza'}], external_urls},
            ]}}};
        },
    });
    const result = await resolver.resolve('spotify', 'Ah Jesus', 'Julliany Souza');
    assert.equal(result.status, 'found');
    assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('provider failure and absent credentials never mean song does not exist', async () => {
    const resolver = createSongLinks({env: {}, get: async () => ({data: '<html>No results</html>'})});
    assert.equal((await resolver.resolve('spotify', 'Song', 'Artist')).status, 'configuration_required');
    assert.equal((await resolver.resolve('youtube', 'Song', 'Artist')).status, 'unavailable');
});

test('link lookup is limited to songs saved in the callers ministry', async () => {
    let handler, resolved = 0;
    const records = {users: {me: {church_id: 'church'}, other: {church_id: 'other'}},
        schedules: {event: {church_id: 'church', suggested_songs: [{title: 'Song', artist: 'Artist'}]}}};
    const db = {collection: name => ({doc: id => ({get: async () => ({data: () => records[name][id]})})})};
    mountMemberActions({post: (path, ...args) => {if (path === '/members/song-links') handler = args.at(-1);}}, {
        authenticate: () => {}, limit: () => {}, getAdmin: () => ({firestore: () => db}),
        songLinks: {resolve: async () => {resolved++; return {status: 'unconfirmed'};}},
    });
    const body = {scheduleId: 'event', title: 'Song', artist: 'Artist', platform: 'youtube'};
    let status = 200;
    const res = {status: code => {status = code; return res;}, json: () => {}};
    await handler({firebaseUser: {uid: 'other'}, body}, res);
    assert.equal(status, 403);
    assert.equal(resolved, 0);
    await handler({firebaseUser: {uid: 'me'}, body: {...body, title: 'Unsaved'}}, res);
    assert.equal(status, 404);
    await handler({firebaseUser: {uid: 'me'}, body}, res);
    assert.equal(resolved, 1);
});
