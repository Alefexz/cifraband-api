const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCatalog, createCatalogSearch } = require('./lib/catalog-search');
const content = 'C G\nHoje vamos cantar juntos nesta casa\nAm F\nUma nova historia começa aqui';
const docs = [
    { id: 'a', title: 'Canção de Teste', artist: 'Banda Teste', content },
    { id: 'b', title: 'Canção de Teste - 545', artist: 'Harpa', content },
    { id: 'c', title: 'Outra Musica', artist: 'Outro Artista', content: 'C G Am F' },
];
test('catalog matches title artist accents and retains only usable songs', () => {
    const catalog = buildCatalog(docs);
    assert.equal(catalog.size, 2);
    assert.equal(catalog.search('cancao banda teste')[0].cacheId, 'a');
    assert.equal(catalog.search('outra musica').length, 0);
});
test('lyrics require phrase; returns metadata without full lyrics', () => {
    const hits = buildCatalog(docs).search('vamos cantar juntos nesta casa');
    assert.equal(hits[0].catalogMatch, 'lyrics');
    assert.equal(hits[0].content, undefined);
    assert.equal(hits[0].lyrics, undefined);
    assert.equal(buildCatalog(docs).search('casa historia cantar').length, 0);
});
test('limited typos work but hymn numbers never fuzzy match', () => {
    const catalog = buildCatalog(docs);
    assert.ok(catalog.search('cancao bonda teste').length > 0);
    assert.equal(catalog.search('546 cancao').length, 0);
    assert.equal(catalog.search('545 cancao')[0].cacheId, 'b');
});
test('completes last word, prioritizes exact titles, never prefixes numbers', () => {
    const catalog = buildCatalog([
        ...docs,
        { id: 'd', title: 'Cancao', artist: 'Teste', content },
        { id: 'e', title: 'Cancao 5450', artist: 'Harpa', content },
    ]);
    assert.equal(catalog.search('cancao')[0].cacheId, 'd');
    assert.ok(catalog.search('cancao band').some(hit => hit.cacheId === 'a'));
    assert.equal(catalog.search('545')[0].cacheId, 'b');
    assert.ok(!catalog.search('545').some(hit => hit.cacheId === 'e'));
});
test('stale searches return immediately while only one refresh loads', async () => {
    let time = 0, calls = 0, release;
    const search = createCatalogSearch({
        load: () => ++calls === 1 ? docs : new Promise(resolve => { release = resolve; }),
        now: () => time, ttl: 10,
    });
    await search('cancao');
    time = 11;
    const results = await Promise.all([search('cancao'), search('banda')]);
    assert.equal(calls, 2);
    assert.ok(results.every(result => result.stale && result.results.length));
    release([...docs, { id: 'new', title: 'Nova Cancao', artist: 'Teste', content }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await search('nova cancao')).results[0].cacheId, 'new');
    assert.equal(calls, 2);
});
test('hung initial catalog load times out and uses retry backoff', async () => {
    let calls = 0;
    const search = createCatalogSearch({
        load: () => { calls++; return new Promise(() => {}); }, loadTimeout: 10,
    });
    await assert.rejects(search('cancao'), /catalog_load_timeout/);
    await assert.rejects(search('cancao'), /catalog_unavailable/);
    assert.equal(calls, 1);
});
test('coalesces loads and reuses index until TTL', async () => {
    let calls = 0, time = 100;
    const search = createCatalogSearch({ load: async () => { calls++; return docs; }, now: () => time, ttl: 10 });
    await Promise.all([search('cancao'), search('banda')]);
    assert.equal(calls, 1);
    await search('cancao');
    assert.equal(calls, 1);
    time += 11;
    await search('cancao');
    assert.equal(calls, 2);
});
test('refresh failure preserves valid index; initial failure is an error', async () => {
    let fail = false, time = 1;
    const load = async () => { if (fail) throw Error('offline'); return docs; };
    const search = createCatalogSearch({ load, now: () => time, ttl: 10 });
    await search('cancao');
    fail = true; time += 11;
    const result = await search('cancao');
    assert.equal(result.stale, true);
    assert.ok(result.results.length);
    await assert.rejects(createCatalogSearch({ load })('cancao'));
});
