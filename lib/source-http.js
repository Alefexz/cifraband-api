const axios = require('axios');
const {safeSourceUrl} = require('./discovery-index');

const MAX_BYTES = 1500000;
const CIFRA_HOSTS = new Set(['www.cifraclub.com.br', 'cifraclub.com.br']);
function supportedUrl(value) {
    const safe = safeSourceUrl(value);
    return safe && CIFRA_HOSTS.has(new URL(safe).hostname) ? safe : '';
}
function transportError(message, code, response) {
    return Object.assign(new Error(message), {code, response});
}
function createSourceHttp({get, getBudget = () => null, createClient = () => {
    const {Impit} = require('impit');
    return new Impit({browser: 'chrome', timeout: 2500});
}, enabled = () => process.env.CHORD_COMPAT_TRANSPORT !== 'off'} = {}) {
    let client;
    return async function getHtml(url, options = {}) {
        const started = Date.now();
        try { return await get(url, options); }
        catch (original) {
            // One compatibility attempt for a public chart, never for auth or rate-limit errors.
            if (!enabled() || !axios.isAxiosError(original) || original.response?.status !== 403 ||
                !supportedUrl(url)) throw original;
            const budget = getBudget();
            const remaining = Math.min(2500, budget?.timeout ?? Infinity,
                (options.timeout || 9000) - (Date.now() - started));
            const signals = [options.signal, budget?.signal].filter(Boolean);
            if (remaining < 100 || signals.some(signal => signal.aborted)) throw original;
            const controller = new AbortController();
            const signal = AbortSignal.any([...signals, controller.signal]);
            let onAbort;
            const cancelled = new Promise((_, reject) => {
                onAbort = () => reject(transportError('Source request cancelled or timed out', 'ECONNABORTED'));
                signal.addEventListener('abort', onAbort, {once: true});
            });
            const timer = setTimeout(() => controller.abort(), remaining);
            const maxBytes = Math.min(MAX_BYTES, options.maxContentLength > 0 ? options.maxContentLength : MAX_BYTES);
            async function request() {
                client ||= createClient();
                let target = supportedUrl(url);
                const maxRedirects = Math.min(5, options.maxRedirects ?? 5);
                for (let hop = 0; ; hop++) {
                    signal.throwIfAborted();
                    // No application headers, Firebase tokens, cookies or proxy credentials are forwarded.
                    const response = await client.fetch(target, {signal, redirect: 'manual'});
                    const headers = Object.fromEntries(response.headers.entries());
                    if ([301, 302, 303, 307, 308].includes(response.status)) {
                        void response.body?.cancel().catch(() => {});
                        const next = headers.location && supportedUrl(new URL(headers.location, target).href);
                        if (!next || hop >= maxRedirects) throw transportError('Untrusted or excessive source redirect', 'ERR_SOURCE_REDIRECT');
                        target = next;
                        continue;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        void response.body?.cancel().catch(() => {});
                        throw transportError(`Source HTTP ${response.status}`, 'ERR_SOURCE_HTTP', {status: response.status, headers});
                    }
                    if (Number(headers['content-length']) > maxBytes) {
                        void response.body?.cancel().catch(() => {});
                        throw transportError('Source response too large', 'ERR_SOURCE_SIZE');
                    }
                    const reader = response.body?.getReader();
                    const cancelReader = () => { if (reader) void reader.cancel().catch(() => {}); };
                    signal.addEventListener('abort', cancelReader, {once: true});
                    const chunks = [];
                    let bytes = 0, complete = false;
                    try {
                        if (reader) while (true) {
                            signal.throwIfAborted();
                            const chunk = await reader.read();
                            if (chunk.done) { complete = true; break; }
                            bytes += chunk.value.byteLength;
                            if (bytes > maxBytes) throw transportError('Source response too large', 'ERR_SOURCE_SIZE');
                            chunks.push(Buffer.from(chunk.value));
                        }
                    } finally {
                        signal.removeEventListener('abort', cancelReader);
                        if (reader && !complete) void reader.cancel().catch(() => {});
                        reader?.releaseLock();
                    }
                    signal.throwIfAborted();
                    return {status: response.status, headers, data: Buffer.concat(chunks).toString(options.responseEncoding || 'utf8'),
                        request: {res: {responseUrl: target}}, transport: 'impit', recoveredStatus: 403};
                }
            }
            try { return await Promise.race([request(), cancelled]); }
            finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort(); }
        }
    };
}

module.exports = {createSourceHttp, supportedUrl};
