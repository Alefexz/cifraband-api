const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createDiscoveryIndex, safeSourceUrl, cleanLinks} = require('./lib/discovery-index');
const {createQueryCorrector} = require('./lib/query-correction');
const {createCatalogSearch} = require('./lib/catalog-search');
const {createCandidateReranker, createLocalScorer} = require('./lib/candidate-reranker');
const {analyzeChordContent, classifyPageContent} = require('./lib/chord-content');
const {withSources, contentFinding, contentFindings} = require('./lib/source-diagnostics');
const cheerio = require('cheerio');

const link = {title: 'Corinhos de Fogo', artist: 'Midian Lima',
    url: 'https://www.cifraclub.com.br/midian-lima/medley-corinhos-de-fogo/'};
function store() {
    const values = new Map();
    return {read: async key => values.get(key), merge: async (key, value) => {
        const current = values.get(key);
        values.set(key, {...value, links: cleanLinks([...(current?.links || []), ...value.links])});
    }};
}
test('verified URL and artist catalog survive a new process/index instance', async () => {
    const db = store(), first = createDiscoveryIndex({store: db});
    await first.rememberSong('Midian Lima', 'Medley - Corinhos de Fogo', link);
    await first.rememberArtist('midian-lima', [link]);
    const second = createDiscoveryIndex({store: db});
    assert.equal((await second.known('Midian Lima', 'Medley - Corinhos de Fogo'))[0].url, link.url);
    assert.equal((await second.artist('midian-lima')).links.length, 1);
    assert.deepEqual(await second.known('Outra Cantora', link.title), []);
});
test('failed empty refresh preserves stale metadata', async () => {
    let now = 1;
    const index = createDiscoveryIndex({store: store(), now: () => now, ttl: 10});
    await index.rememberArtist('midian-lima', [link]);
    now = 100;
    await index.rememberArtist('midian-lima', []);
    const value = await index.artist('midian-lima');
    assert.equal(value.stale, true);
    assert.equal(value.links[0].url, link.url);
});
test('unavailable persistence cannot hold up the query', async () => {
    const index = createDiscoveryIndex({store: {read: () => new Promise(() => {})}, readTimeout: 15});
    const start = Date.now();
    assert.deepEqual(await index.known('A', 'B'), []);
    assert.ok(Date.now() - start < 250);
});
test('a late persisted read warms memory without repeating the database query', async () => {
    let finish, calls = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const index = createDiscoveryIndex({store: {read: () => { calls++; return pending; }}, readTimeout: 5});
    assert.deepEqual(await index.known('Midian Lima', link.title), []);
    finish({links: [link], checkedAt: Date.now()});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await index.known('Midian Lima', link.title))[0].url, link.url);
    assert.equal(calls, 1);
});
test('unverified discovery cannot overwrite previously verified identity', () => {
    const result = cleanLinks([{...link, verified: true}, {...link, title: 'Wrong title', verified: false}]);
    assert.equal(result[0].title, link.title);
    assert.equal(result[0].verified, true);
});
test('rejects untrusted URLs, credentials, alternate ports and lyric-only routes', () => {
    for (const url of ['http://127.0.0.1/admin', 'https://evil.test/chart',
        'https://www.cifraclub.com.br.evil.test/a/b/', 'https://user:pass@www.cifraclub.com.br/a/b/',
        'https://www.cifraclub.com.br:444/a/b/', 'https://www.cifraclub.com.br/a/b/letra/',
        'https://www.cifraclub.com.br/a/b/partituras/']) assert.equal(safeSourceUrl(url), '');
    assert.equal(safeSourceUrl(link.url + '?secret=123#x'), link.url);
});
test('metadata is bounded by bytes and contains no lyrics or private fields', () => {
    const links = cleanLinks(Array.from({length: 1500}, (_, i) => ({...link, title: 'Á'.repeat(300),
        url: link.url + i, content: 'private', token: 'private'})));
    assert.ok(Buffer.byteLength(JSON.stringify(links)) < 700000);
    assert.ok(links.length <= 800);
    assert.equal(links[0].content, undefined);
    assert.equal(links[0].token, undefined);
});
const documents = [{id: '1', title: 'Corinhos de Fogo', artist: 'Midian Lima', metadataOnly: true, url: link.url},
    {id: '2', title: 'Sol Nos Olhos', artist: 'Jorge e Mateus', metadataOnly: true},
    {id: '3', title: 'Porque Ele Vive 545', artist: 'Harpa Crista', metadataOnly: true}];
test('musical vocabulary corrects joined names without altering hymn numbers', () => {
    const correct = createQueryCorrector(documents);
    assert.equal(correct('jorgeemateus'), 'jorge e mateus');
    assert.equal(correct('midiam lima'), 'midian lima');
    assert.equal(correct('545'), null);
    assert.equal(correct('546 porque ele vive'), null);
    assert.equal(correct('nome completamente desconhecido'), null);
});
test('catalog correction returns the real selected identity and source URL', async () => {
    const search = createCatalogSearch({load: async () => documents});
    const result = await search('corinhosdefogo');
    assert.equal(result.correctedQuery, 'corinhos de fogo');
    assert.equal(result.results[0].trackName, 'Corinhos de Fogo');
    assert.equal(result.results[0].artistName, 'Midian Lima');
    assert.equal(result.results[0].sourceUrl, link.url);
    assert.equal(result.results[0].provider, 'discovery_index');
    assert.deepEqual((await search('546')).results, []);
});
test('AI changes order only, exact matches bypass inference', async () => {
    let calls = 0;
    const rerank = createCandidateReranker({score: async () => {calls++; return [0, 9];}});
    const candidates = [{title: 'Canto Um'}, {title: 'Canto Dois'}, {title: 'Outro'}];
    const result = await rerank('canto', candidates, {eligible: item => item.title !== 'Outro'});
    assert.equal(result[0], candidates[1]);
    assert.equal(result[2], candidates[2]);
    assert.deepEqual(await rerank('canto', candidates, {exact: item => item === candidates[0]}), candidates);
    assert.equal(calls, 1);
});
test('AI failure, timeout and invalid scores retain lexical results', async () => {
    const items = [{title: 'A'}, {title: 'B'}];
    for (const score of [async () => {throw Error('offline');}, async () => [NaN, 1], async () => [1],
        () => new Promise(() => {})]) {
        const rank = createCandidateReranker({score, timeoutMs: 10});
        assert.deepEqual(await rank('query', items), items);
    }
});
test('disabled scorer does not download or delay requests', async () => {
    const scorer = createLocalScorer({mode: 'off'});
    scorer.start();
    assert.equal(scorer.status(), 'disabled');
    assert.equal(await scorer.score('x', ['a', 'b']), null);
    await scorer.stop();
});
test('classifies complete chart, tabs, lyrics, chords, empty and unparseable pages', () => {
    assert.equal(analyzeChordContent('C G Am\nUma frase para cantar\nOutra frase para tocar').kind, 'chord_with_lyrics');
    assert.equal(analyzeChordContent('E|--0--2--|\nB|--3--0--|').kind, 'tablature_only');
    assert.equal(analyzeChordContent('Uma frase para cantar\nOutra frase para tocar').kind, 'lyrics_only');
    assert.equal(analyzeChordContent('C G Am F').kind, 'chords_only');
    assert.equal(analyzeChordContent('').kind, 'empty_content');
    assert.equal(classifyPageContent(cheerio.load('<nav>Site menu</nav>')), 'parse_error');
});
test('content findings are isolated per request and redact URL query strings', async () => {
    await withSources(async () => {
        contentFinding(link.url + '?token=secret', 'tablature_only');
        assert.deepEqual(contentFindings(), [{url: link.url, kind: 'tablature_only'}]);
    });
    assert.deepEqual(contentFindings(), []);
});
