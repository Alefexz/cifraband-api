function createReferenceEnricher({ resolve, persist, onError = () => {},
    concurrency = 2, capacity = 50, cooldownMs = 10 * 60 * 1000 }) {
    const pending = new Set();
    const recent = new Map();
    const queue = [];
    let active = 0;
    function drain() {
        while (active < concurrency && queue.length) {
            const task = queue.shift();
            active++;
            Promise.resolve().then(() => resolve(task.song.artist || task.artist,
                task.song.title || task.track))
                .then(reference => reference ? persist(task, reference) : undefined)
                .catch(error => onError(error))
                .finally(() => {
                    active--;
                    pending.delete(task.key);
                    drain();
                });
        }
    }
    return task => {
        if (task.song.referenceUrl || pending.has(task.key) || pending.size >= capacity) return false;
        const now = Date.now();
        if (recent.has(task.key) && now - recent.get(task.key) < cooldownMs) return false;
        recent.delete(task.key);
        recent.set(task.key, now);
        while (recent.size > 500) recent.delete(recent.keys().next().value);
        pending.add(task.key);
        queue.push({ ...task, song: { ...task.song } });
        setImmediate(drain);
        return true;
    };
}

function sendSongWithReference(res, song, identity, enrich) {
    // Optional enrichment starts only after the HTTP response has been sent.
    res.once('finish', () => enrich({ ...identity, song }));
    return res.status(200).json(song);
}

module.exports = { createReferenceEnricher, sendSongWithReference };
