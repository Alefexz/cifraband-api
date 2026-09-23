const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { setTimeout: delay, setImmediate: nextTurn } = require('node:timers/promises');
const { readFileSync } = require('node:fs');
const { createReferenceEnricher, sendSongWithReference } = require('./lib/youtube-background');
const song = { title: 'Local audit', artist: 'Test', content: 'C G\nSynthetic words', referenceUrl: '' };
const task = { key: 'test', artist: 'Test', track: 'Local audit', song };
const reference = { url: 'https://youtube.test/watch?v=test', source: 'test', title: 'Test', score: 100 };

async function localServer(handler, run) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await run(`http://127.0.0.1:${server.address().port}`); }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test('HTTP response no longer waits for YouTube: controlled before/after measurement', async t => {
    const resolve = async () => { await delay(300); return reference; };
    let persistDone;
    const done = new Promise(r => { persistDone = r; });
    const enrich = createReferenceEnricher({ resolve, persist: () => persistDone() });
    const app = express();
    app.get('/before', async (_req, res) => { await resolve(); res.json(song); });
    app.get('/after', (_req, res) => sendSongWithReference(res, song, task, enrich));
    await localServer(app, async url => {
        const startBefore = performance.now();
        assert.deepEqual(await (await fetch(`${url}/before`)).json(), song);
        const before = performance.now() - startBefore;
        const startAfter = performance.now();
        assert.deepEqual(await (await fetch(`${url}/after`)).json(), song);
        const after = performance.now() - startAfter;
        t.diagnostic(`Synthetic YouTube delay=300ms; HTTP before=${before.toFixed(1)}ms after=${after.toFixed(1)}ms`);
        assert.ok(before >= 280);
        assert.ok(after < before * .75, 'response must not wait for optional reference');
        await done;
    });
});

test('hung resolver cannot hold song response; duplicate jobs do not multiply', async () => {
    let finish;
    let calls = 0;
    let writes = 0;
    const gate = new Promise(r => { finish = r; });
    const enrich = createReferenceEnricher({ resolve: () => { calls++; return gate; }, persist: () => { writes++; } });
    const app = express();
    app.get('/', (_req, res) => sendSongWithReference(res, song, task, enrich));
    await localServer(app, async url => {
        for (let i = 0; i < 2; i++) {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), song);
        }
        assert.equal(calls, 1);
        assert.equal(writes, 0);
        finish(reference);
        await nextTurn();
        assert.equal(writes, 1);
        assert.equal(song.referenceUrl, '');
    });
});

test('failed enrichment is caught; existing references skipped; queue is bounded', async () => {
    const errors = [];
    const enrich = createReferenceEnricher({ capacity: 1, resolve: async () => { throw Error('offline'); },
        persist: () => assert.fail('No persistence on error'), onError: e => errors.push(e.message) });
    assert.equal(enrich({ ...task, song: { ...song, referenceUrl: reference.url } }), false);
    assert.equal(enrich(task), true);
    assert.equal(enrich({ ...task, key: 'second' }), false);
    await nextTurn();
    assert.deepEqual(errors, ['offline']);
    assert.equal(enrich(task), false, 'failed job should not hammer YouTube repeatedly');
});

test('production song paths use the nonblocking responder and no resolver await', () => {
    const source = readFileSync(require.resolve('./server'), 'utf8');
    assert.equal((source.match(/sendSongWithReference\(res,/g) || []).length, 4);
    assert.doesNotMatch(source, /await\s+resolveYoutubeReference\(/);
});
