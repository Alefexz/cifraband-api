const {Worker} = require('node:worker_threads');
const path = require('node:path');
const os = require('node:os');

function createLocalScorer({mode = process.env.CHORD_AI_MODE || 'auto',
    cacheDir = process.env.CHORD_AI_CACHE_DIR || path.join(os.homedir(), '.cache', 'cifra-band-models'),
    startupTimeout = 60000, inferenceTimeout = 4000, allowDownload = false} = {}) {
    let worker, ready = false, busy = false, sequence = 0, initTimer, inferenceTimer, state = 'not_started', detail = '';
    const pending = new Map();
    function stop(reason = 'stopped') {
        ready = false; busy = false; state = reason;
        clearTimeout(initTimer); clearTimeout(inferenceTimer);
        for (const resolve of pending.values()) resolve(null);
        pending.clear();
        const old = worker; worker = null;
        return old?.terminate();
    }
    function start() {
        if (worker || state !== 'not_started') return;
        const memory = typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem();
        if (mode === 'off' || (mode === 'auto' && memory < 768 * 1024 * 1024)) {
            state = mode === 'off' ? 'disabled' : 'insufficient_memory'; return;
        }
        state = 'loading';
        worker = new Worker(path.join(__dirname, 'reranker-worker.js'), {workerData: {cacheDir, allowDownload}});
        worker.unref();
        initTimer = setTimeout(() => { void stop('startup_timeout'); }, startupTimeout);
        initTimer.unref();
        worker.on('error', error => { detail = error.message; void stop('worker_error'); });
        worker.on('exit', () => { if (worker) void stop('worker_exited'); });
        worker.on('message', message => {
            if (message.ready) { ready = true; state = 'ready'; clearTimeout(initTimer); return; }
            if (message.fatal) { detail = message.fatal; void stop('load_failed'); return; }
            clearTimeout(inferenceTimer); busy = false;
            pending.get(message.id)?.(message.scores || null); pending.delete(message.id);
        });
    }
    return {
        start, stop, status: () => state, detail: () => detail,
        score(query, documents) {
            if (!ready || busy || !documents.length || documents.length > 8) return Promise.resolve(null);
            busy = true;
            const id = ++sequence;
            return new Promise(resolve => {
                pending.set(id, resolve);
                inferenceTimer = setTimeout(() => { void stop('inference_timeout'); }, inferenceTimeout);
                worker.postMessage({id, query: query.slice(0, 400), documents: documents.map(d => d.slice(0, 500))});
            });
        },
    };
}

function createCandidateReranker({score, timeoutMs = 150, normalize = value => String(value).toLowerCase().trim()}) {
    return async (query, candidates, {eligible = () => true, exact = () => false} = {}) => {
        const original = candidates.slice();
        // AI may reorder only a small ambiguous lexical band, never rescue an invalid identity.
        const band = original.filter(eligible).slice(0, 8);
        if (band.length < 2 || band.some(exact)) return original;
        const text = band.map(item => `${item.title || item.trackName} - ${item.artist || item.artistName || ''}`);
        if (text.some(value => normalize(value) === normalize(query))) return original;
        let timer;
        try {
            const scores = await Promise.race([Promise.resolve().then(() => score(query, text)),
                new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]);
            if (!Array.isArray(scores) || scores.length !== band.length || scores.some(n => !Number.isFinite(n))) return original;
            const ranked = band.map((item, i) => ({item, score: scores[i]})).sort((a, b) => b.score - a.score);
            let next = 0;
            const allowed = new Set(band);
            return original.map(item => allowed.has(item) ? ranked[next++].item : item);
        } catch { return original; }
        finally { clearTimeout(timer); }
    };
}
module.exports = {createLocalScorer, createCandidateReranker};
