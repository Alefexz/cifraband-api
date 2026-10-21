const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setTimeout: sleep} = require('node:timers/promises');
const {resolveCacheAndSource: race} = require('./lib/cache-source-race');
const chart = {content: 'validated'};

test('fast cache avoids external requests', async () => {
    let calls = 0;
    assert.equal(await race({readCache: async () => chart,
        loadSource: async () => { calls++; return {}; }}), chart);
    assert.equal(calls, 0);
});
test('late valid cache beats an already failed source', async () => {
    const result = await race({headStartMs: 2, timeoutMs: 100,
        readCache: async () => { await sleep(25); return chart; },
        loadSource: async () => { throw Error('403'); }});
    assert.equal(result, chart);
});
test('late cache aborts pending source work', async () => {
    let signal;
    const result = await race({headStartMs: 2, timeoutMs: 150,
        readCache: async () => { await sleep(25); return chart; },
        loadSource: args => { signal = args.signal; return new Promise(() => {}); }});
    assert.equal(result, chart);
    assert.equal(signal.aborted, true);
});
test('wrong selected version is ignored and source wins', async () => {
    assert.equal(await race({readCache: async () => ({url: 'other'}), acceptCache: value => value.url === 'selected',
        loadSource: async () => chart}), chart);
});
test('cache error does not mask valid source', async () => {
    assert.equal(await race({readCache: async () => {throw Error('database');}, loadSource: async () => chart}), chart);
});
test('both missing preserve source failure', async () => {
    const error = Object.assign(Error('blocked'), {statusCode: 503});
    await assert.rejects(race({readCache: async () => null, loadSource: async () => {throw error;}}), e => e === error);
});
test('hung cache and hung source obey overall deadline', async () => {
    await assert.rejects(race({timeoutMs: 30, headStartMs: 1, readCache: () => new Promise(() => {}),
        loadSource: () => new Promise(() => {})}), e => e.statusCode === 504);
});
