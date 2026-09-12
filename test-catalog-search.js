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
