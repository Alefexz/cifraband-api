const {test} = require('node:test');
const assert = require('node:assert/strict');
const {withSources, sourceBlocked, sourceFailure, sourceFailures, sourceAttempt, sourceAttempts, sourceRequestOptions} = require('./lib/source-diagnostics');

const url = 'https://www.cifraclub.com.br/lauriete/joao-viu/';
const error = status => ({response: {status}});

test('cache winner can cancel an ongoing source search through its parent signal', async () => {
    const controller = new AbortController();
    let transportSignal;
    const search = withSources(async () => {
        transportSignal = sourceRequestOptions().signal;
        controller.abort();
        return new Promise(() => {});
    }, {signal: controller.signal, timeoutMs: 1000});
    await assert.rejects(search, error => error.code === 'SEARCH_TIMEOUT');
    assert.equal(transportSignal.aborted, true);
});

test('one source deadline aborts transport and prevents further source attempts', async () => {
    let signal, afterAbort;
    await assert.rejects(withSources(async () => {
        signal = sourceRequestOptions().signal;
        afterAbort = new Promise(resolve => signal.addEventListener('abort', () => {
            assert.equal(sourceBlocked(url), true);
            assert.throws(sourceRequestOptions, err => err.code === 'SEARCH_TIMEOUT');
            resolve();
        }, {once:true}));
        return new Promise(() => {});
    }, {timeoutMs:30}), err => err.statusCode === 504 && err.reason === 'deadline_exceeded');
    assert.equal(signal.aborted,true);
    await afterAbort;
    assert.equal(sourceRequestOptions(),null);
});

test('completion clears deadline and cancels other workers without changing result', async () => {
    let signal;
    const result = await withSources(async () => {
        signal = sourceRequestOptions().signal;
        return 'validated chart';
    }, {timeoutMs:100});
    assert.equal(result,'validated chart');
    assert.equal(signal.aborted,true);
});

test('403 suppresses its path, not other paths before five samples', async () => {
    await withSources(async () => {
        sourceFailure(url, error(403));
        assert.equal(sourceBlocked(url), true);
        sourceFailure(url, error(403));
        assert.equal(sourceBlocked('https://www.cifraclub.com.br/untried'), false);
        sourceFailure('https://www.cifraclub.com.br/lauriete/outra-musica/', error(403));
        assert.equal(sourceBlocked(url), true);
        assert.equal(sourceBlocked('https://www.cifraclub.com.br/untried'), false);
        assert.equal(sourceBlocked('https://www.losacordes.com/acordes/lauriete/joao-viu'), false);
        assert.deepEqual(sourceFailures(), [{host: 'www.cifraclub.com.br', status: 403, attempts: 3}]);
    });
    assert.equal(sourceBlocked(url), false);
    await withSources(async () => {
        sourceFailure(url, error(429));
        assert.equal(sourceBlocked(url), true);
    });
});

test('host circuit requires five distinct paths and more than half forbidden', async () => {
    await withSources(async () => {
        for (let i = 0; i < 3; i++) sourceFailure(`${url}${i}`, error(403));
        sourceAttempt(`${url}ok`, 200);
        assert.equal(sourceBlocked(`${url}untried`), false);
        sourceAttempt(`${url}missing`, 404);
        assert.equal(sourceBlocked(`${url}untried`), true);
    });
    await withSources(async () => {
        for (let i = 0; i < 2; i++) sourceFailure(`${url}${i}`, error(403));
        for (let i = 0; i < 3; i++) sourceAttempt(`${url}ok${i}`, 200);
        assert.equal(sourceBlocked(`${url}untried`), false);
        sourceAttempt(`${url}?token=secret`, 200, 10, {'server': 'test', 'set-cookie': 'secret'});
        const last = sourceAttempts().at(-1);
        assert.equal(last.url.includes('token'), false);
        assert.deepEqual(last.headers, {server: 'test'});
    });
});

test('one transient error and ordinary 404 do not hide available sources', async () => {
    await withSources(async () => {
        sourceFailure(url, error(404));
        sourceFailure(url, error(500));
        assert.equal(sourceBlocked(url), false);
        assert.deepEqual(sourceFailures(), [{host: 'www.cifraclub.com.br', status: 500, attempts: 1}]);
    });
});

test('network and 5xx failures do not hide later valid candidate URLs', async () => {
    await withSources(async () => {
        sourceFailure(url, error(500));
        sourceFailure(url, error(0));
        assert.equal(sourceBlocked(url), false);
        sourceFailure(url, error(502));
        assert.equal(sourceBlocked(url), false);
    });
});

test('full song lookup stops probing blocked hosts and reports unavailability', async () => {
    const axios = require('axios');
    const {findSong} = require('./server');
    const originalGet = axios.get;
    const originalLog = console.log;
    const calls = new Map();
    const requested = new Set();
    axios.get = async target => {
        requested.add(target);
        const host = new URL(target).hostname;
        calls.set(host, (calls.get(host) || 0) + 1);
        throw Object.assign(new Error('Forbidden'), {response: {status: 403}});
    };
    console.log = () => {};
    const start = Date.now();
    try {
        await assert.rejects(
            findSong('Lauriete', 'João Viu'),
            error => error.reason === 'provider_unavailable' && error.statusCode === 503
        );
        assert.ok(Date.now() - start < 2000);
        assert.ok(requested.has(url), 'published João Viu URL must be attempted');
        assert.ok((calls.get('www.cifraclub.com.br') || 0) <= 11);
        assert.ok([...calls.values()].reduce((sum, count) => sum + count, 0) <= 45);
    } finally {
        axios.get = originalGet;
        console.log = originalLog;
    }
});

test('full pipeline aborts stalled HTTP at the shared deadline', async () => {
    const axios = require('axios');
    const {findSong} = require('./server');
    const adapter = axios.defaults.adapter;
    const signals = [];
    axios.defaults.adapter = config => new Promise((resolve, reject) => {
        signals.push(config.signal);
        assert.ok(config.timeout <= 100);
        config.signal.addEventListener('abort', () => reject(new axios.CanceledError()), {once:true});
    });
    try {
        await assert.rejects(findSong('Artista de teste', 'Canto de teste', {timeoutMs:100}),
            error => error.code === 'SEARCH_TIMEOUT' && error.statusCode === 504);
        assert.ok(signals.length > 0);
        assert.ok(signals.every(signal => signal.aborted));
        const attempts = signals.length;
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(signals.length, attempts);
    } finally { axios.defaults.adapter = adapter; }
});

test('validated alternative returns without waiting for stalled source variants', async () => {
    const axios = require('axios');
    const {findSong} = require('./server');
    const adapter = axios.defaults.adapter;
    const signals = [];
    axios.defaults.adapter = config => {
        signals.push(config.signal);
        if (config.url === 'https://www.losacordes.com/acordes/fernandinho/galileu/') {
            return Promise.resolve({status:200, statusText:'OK', headers:{}, config,
                data:'<title>GALILEU Acordes - Fernandinho | LosAcordes.com</title><body>Tono: C<pre id="core">C G Am F\nUma letra sintetica para testar\nOutra frase sintetica para cantar</pre></body>'});
        }
        return new Promise((resolve, reject) => config.signal.addEventListener('abort',
            () => reject(new axios.CanceledError()), {once:true}));
    };
    try {
        const result = await findSong('Fernandinho', 'Galileu', {timeoutMs:1500});
        assert.equal(result.artist, 'Fernandinho');
        assert.equal(result.source, 'los_acordes');
        assert.ok(signals.every(signal => signal.aborted));
        const attempts = signals.length;
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(signals.length, attempts);
    } finally { axios.defaults.adapter = adapter; }
});
