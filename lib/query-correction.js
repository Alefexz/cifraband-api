const MiniSearch = require('minisearch');
const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

// Suggest whole known names; never silently rewrite a selected song's identity.
function createQueryCorrector(documents) {
    const phrases = new Map(), compact = new Map();
    for (const doc of documents) {
        for (const text of [doc.title, doc.artist, `${doc.title} ${doc.artist}`]) {
            const value = normalize(text);
            if (value) phrases.set(value, {id: value, text: value});
        }
    }
    const index = new MiniSearch({fields: ['text'], storeFields: ['text']});
    index.addAll([...phrases.values()]);
    for (const phrase of phrases.keys()) {
        const key = phrase.replace(/ /g, '');
        const values = compact.get(key) || new Set();
        values.add(phrase); compact.set(key, values);
    }
    return query => {
        const q = normalize(query);
        if (!q || q.length > 120 || phrases.has(q) || /\d/.test(q)) return null;
        const joined = [...(compact.get(q.replace(/ /g, '')) || [])];
        if (joined.length === 1) return joined[0];
        const hits = index.search(q, {combineWith: 'AND', prefix: false,
            fuzzy: term => term.length < 4 ? false : term.length < 8 ? 1 : 2})
            .filter(hit => hit.text.split(' ').length === q.split(' ').length);
        if (!hits.length || (hits[1] && hits[0].score < hits[1].score * 1.4)) return null;
        return hits[0].text === q ? null : hits[0].text;
    };
}
module.exports = {createQueryCorrector};
