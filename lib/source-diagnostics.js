const {AsyncLocalStorage} = require('node:async_hooks');
const searches = new AsyncLocalStorage();
function deadlineError(active) {
    return Object.assign(new Error('As fontes nao responderam a tempo. Tente novamente; a cifra pode existir.'), {
        code: 'SEARCH_TIMEOUT', statusCode: 504, reason: 'deadline_exceeded',
        diagnostics: {sourceFailures: [...active.failures.values()], sourceAttempts: active.attempts.slice(-40),
            contentFindings: active.findings.slice(-20)}
    });
}
const withSources = (action, {timeoutMs = 8000, signal} = {}) => {
    const active = {failures: new Map(), blockedHosts: new Set(), paths: new Map(), attempts: [], findings: [],
        controller: new AbortController(), deadline: Date.now() + timeoutMs};
    return searches.run(active, async () => {
        let timer, onAbort;
        const cancelled = new Promise((_, reject) => {
            onAbort = () => { active.controller.abort(); reject(deadlineError(active)); };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, {once: true});
        });
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { active.controller.abort(); reject(deadlineError(active)); }, timeoutMs);
        });
        try {
            const result = await Promise.race([Promise.resolve().then(action), deadline, cancelled]);
            if (Date.now() >= active.deadline || active.controller.signal.aborted) throw deadlineError(active);
            return result;
        } catch (error) {
            // An HTTP interceptor can notice expiry before the timer callback.
            if (Date.now() >= active.deadline || active.controller.signal.aborted) throw deadlineError(active);
            throw error;
        }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); active.controller.abort(); }
    });
};
function sourceRequestOptions() {
    const active = searches.getStore();
    if (!active) return null;
    const remaining = active.deadline - Date.now();
    if (active.controller.signal.aborted || remaining <= 0) throw deadlineError(active);
    return {signal: active.controller.signal, timeout: remaining};
}
function sourceBlocked(url) {
    const active = searches.getStore();
    const parsed = new URL(url);
    return Boolean(active && (active.controller.signal.aborted || active.blockedHosts.has(parsed.hostname) ||
        active.paths.get(parsed.origin + parsed.pathname) === 403));
}
function sourceAttempt(url, status, elapsedMs = 0, headers = {}, reason = '') {
    const active = searches.getStore();
    if (!active) return;
    const parsed = new URL(url);
    const host = parsed.hostname;
    const safeUrl = parsed.origin + parsed.pathname;
    active.paths.set(safeUrl, status);
    const safeHeaders = {};
    for (const key of ['server', 'content-type', 'retry-after', 'via', 'cf-ray']) {
        if (headers[key]) safeHeaders[key] = String(headers[key]).slice(0, 200);
    }
    const attempt = {host, url: safeUrl, status, elapsedMs, reason, headers: safeHeaders};
    active.attempts.push(attempt);
    console.log(JSON.stringify({event: 'chord_source_attempt', ...attempt}));
    const hostPaths = [...active.paths].filter(([path]) => new URL(path).hostname === host);
    const forbidden = hostPaths.filter(([, code]) => code === 403).length;
    if (hostPaths.length >= 5 && forbidden / hostPaths.length > 0.5) active.blockedHosts.add(host);
    if (status === 429) active.blockedHosts.add(host);
}
function sourceFailure(url, error, elapsedMs = 0) {
    const active = searches.getStore();
    if (!active) return;
    const status = error.response?.status || 0;
    sourceAttempt(url, status, elapsedMs, error.response?.headers,
        status ? `http_${status}` : error.code === 'ECONNABORTED' ? 'timeout' : 'transport_error');
    if (status === 404) return;
    const host = new URL(url).hostname;
    const key = `${host}:${status}`;
    const prior = active.failures.get(key);
    active.failures.set(key, {host, status, attempts: (prior?.attempts || 0) + 1});
}
const sourceFailures = () => [...(searches.getStore()?.failures.values() || [])];
const sourceAttempts = () => [...(searches.getStore()?.attempts || [])];
function contentFinding(url, kind) {
    const active = searches.getStore();
    if (!active) return;
    const parsed = new URL(url);
    active.findings.push({url: parsed.origin + parsed.pathname, kind});
    if (active.findings.length > 40) active.findings.shift();
}
const contentFindings = () => [...(searches.getStore()?.findings || [])];
module.exports = {withSources, sourceFailure, sourceFailures, sourceBlocked, sourceAttempt, sourceAttempts,
    sourceRequestOptions, contentFinding, contentFindings};
