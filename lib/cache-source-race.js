// Keep a late cache hit eligible while the external resolver runs.
function resolveCacheAndSource({readCache, loadSource, acceptCache = Boolean,
    timeoutMs = 8750, headStartMs = 150, onResult = () => {}}) {
    const controller = new AbortController();
    const started = Date.now();
    return new Promise((resolve, reject) => {
        let done = false, cacheDone = false, sourceDone = false, sourceStarted = false;
        let sourceError, hedgeTimer;
        const finish = (error, value, origin) => {
            if (done) return;
            done = true;
            clearTimeout(deadlineTimer); clearTimeout(hedgeTimer);
            controller.abort();
            if (error) reject(error);
            else {
                try { onResult({origin, elapsedMs: Date.now() - started}); } catch {}
                resolve(value);
            }
        };
        const exhausted = () => {
            if (cacheDone && sourceDone) finish(sourceError || Error('No validated chart'));
        };
        const deadlineTimer = setTimeout(() => finish(sourceError || Object.assign(
            Error('A busca nao terminou a tempo; a cifra pode existir.'),
            {code: 'SEARCH_TIMEOUT', statusCode: 504, reason: 'deadline_exceeded'})), timeoutMs);
        function startSource() {
            if (done || sourceStarted) return;
            sourceStarted = true;
            const remaining = Math.max(1, timeoutMs - (Date.now() - started));
            Promise.resolve().then(() => loadSource({signal: controller.signal, timeoutMs: remaining}))
                .then(value => {
                    if (!value) throw Error('No validated chart');
                    finish(null, value, 'source');
                }).catch(error => { sourceError = error; sourceDone = true; exhausted(); });
        }
        hedgeTimer = setTimeout(startSource, headStartMs);
        Promise.resolve().then(readCache).then(value => {
            if (done) return;
            if (acceptCache(value)) finish(null, value, 'cache');
            else { cacheDone = true; startSource(); exhausted(); }
        }).catch(() => { cacheDone = true; startSource(); exhausted(); });
    });
}

module.exports = {resolveCacheAndSource};
