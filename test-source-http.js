const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {createSourceHttp, supportedUrl} = require('./lib/source-http');

const URL = 'https://www.cifraclub.com.br/harpa-crista/tu-es-fiel-senhor/';
const denied = status => new axios.AxiosError('Denied', 'ERR_BAD_REQUEST', {}, {}, {status});
const reject = async () => { throw denied(403); };
function setup(fetch, extra = {}) {
    return createSourceHttp({get: reject, createClient: () => ({fetch}), ...extra});
}

test('normal HTTP success does not initialize a second client', async () => {
    const expected = {status: 200, data: 'C G\nCanto'};
    const get = createSourceHttp({get: async () => expected, createClient: () => assert.fail('Unexpected fallback')});
    assert.equal(await get(URL), expected);
});
test('403 compatibility uses public URL only and preserves UTF-8 and final URL', async () => {
    const get = setup(async (url, options) => {
        assert.equal(url, URL);
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers, undefined);
        return new Response('Tu \u00e9s fiel\nC G');
    });
    const response = await get(URL, {headers: {Authorization: 'PRIVATE', Cookie: 'PRIVATE'}});
    assert.equal(response.data, 'Tu \u00e9s fiel\nC G');
    assert.equal(response.request.res.responseUrl, URL);
    assert.equal(response.transport, 'impit');
});
test('respects explicit disable, unauthorized, not found, rate limit, and unrelated errors', async () => {
    for (const error of [denied(401), denied(404), denied(429), new Error('logic')]) {
        const get = setup(() => assert.fail('Unexpected fallback'), {get: async () => { throw error; }});
        await assert.rejects(get(URL), error);
    }
    await assert.rejects(setup(() => assert.fail('Disabled'), {enabled: () => false})(URL));
});
test('restricts compatibility transport to trusted HTTPS chart hosts without credentials', async () => {
    for (const url of ['http://www.cifraclub.com.br/a/b/', 'https://localhost/a',
        'https://www.cifraclub.com.br.evil.test/a', 'https://user:pass@www.cifraclub.com.br/a',
        'https://www.cifraclub.com.br:8443/a', 'https://www.losacordes.com/a']) {
        assert.equal(supportedUrl(url), '');
        await assert.rejects(setup(() => assert.fail('Untrusted fallback'))(url));
    }
});
test('checks every redirect, permits safe relative destinations and removes tracking', async () => {
    let calls = 0;
    const get = setup(async url => ++calls === 1 ? new Response(null, {status: 302, headers: {location: '/harpa-crista/535/?track=1'}}) :
        (assert.equal(url, 'https://www.cifraclub.com.br/harpa-crista/535/'), new Response('C G')));
    assert.equal((await get(URL)).data, 'C G');
    for (const location of ['https://127.0.0.1/private', 'http://www.cifraclub.com.br/a', 'https://evil.test/a']) {
        let count = 0;
        await assert.rejects(setup(async () => { count++; return new Response(null, {status: 302, headers: {location}}); })(URL),
            {code: 'ERR_SOURCE_REDIRECT'});
        assert.equal(count, 1);
    }
});
test('honors zero redirects and bounds redirect loops', async () => {
    let calls = 0;
    const get = setup(async () => { calls++; return new Response(null, {status: 302, headers: {location: URL}}); });
    await assert.rejects(get(URL, {maxRedirects: 0}), {code: 'ERR_SOURCE_REDIRECT'});
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(get(URL), {code: 'ERR_SOURCE_REDIRECT'});
    assert.equal(calls, 6);
});
test('limits both declared and chunked decoded body sizes', async () => {
    for (const headers of [{}, {'content-length': '200'}]) {
        const get = setup(async () => new Response('a'.repeat(200), {headers}));
        await assert.rejects(get(URL, {maxContentLength: 100}), {code: 'ERR_SOURCE_SIZE'});
    }
});
test('preserves HTTP failure diagnostics and never retries fallback', async () => {
    let calls = 0;
    const get = setup(async () => { calls++; return new Response(null, {status: 429, headers: {'retry-after': '60'}}); });
    await assert.rejects(get(URL), error => error.response.status === 429 && error.response.headers['retry-after'] === '60');
    assert.equal(calls, 1);
});
test('rejects an already cancelled request without fetching', async () => {
    await assert.rejects(setup(() => assert.fail('Cancelled'))(URL, {signal: AbortSignal.abort()}));
});
test('parent cancellation interrupts a client even if it ignores AbortSignal', async () => {
    const controller = new AbortController();
    const get = setup(async () => { controller.abort(); return new Promise(() => {}); },
        {getBudget: () => ({signal: controller.signal, timeout: 2000})});
    await assert.rejects(get(URL), {code: 'ECONNABORTED'});
});
test('timeout includes a stalled body and cancels its reader', async () => {
    let cancelled = false;
    const get = setup(async () => new Response(new ReadableStream({cancel() { cancelled = true; }})));
    await assert.rejects(get(URL, {timeout: 130}), {code: 'ECONNABORTED'});
    // Native transport receives the same abort signal; the race must settle without waiting on a body.
    assert.equal(cancelled, true);
});
test('non-UTF8 response encoding remains explicit', async () => {
    const get = setup(async () => new Response(Uint8Array.from([0x43, 0xe3, 0x6f])));
    assert.equal((await get(URL, {responseEncoding: 'latin1'})).data, 'C\u00e3o');
});
