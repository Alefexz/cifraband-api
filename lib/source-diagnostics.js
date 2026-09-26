const {AsyncLocalStorage} = require('node:async_hooks');
const searches = new AsyncLocalStorage();
const withSources = action => searches.run(new Map(), action);
function sourceFailure(url, error) {
    const active = searches.getStore();
    if (!active) return;
    const status = error.response?.status || 0;
    if (status === 404) return;
    const host = new URL(url).hostname;
    const key = `${host}:${status}`;
    const prior = active.get(key);
    active.set(key, {host, status, attempts: (prior?.attempts || 0) + 1});
}
const sourceFailures = () => [...(searches.getStore()?.values() || [])];
module.exports = {withSources, sourceFailure, sourceFailures};
