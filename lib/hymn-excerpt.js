const {normalize} = require('./search-acceptance-normalize');

const COMMON = new Set(['a', 'as', 'o', 'os', 'e', 'es', 'de', 'da', 'do', 'das', 'dos',
    'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'eu', 'tu', 'me', 'te', 'se', 'que', 'com', 'por', 'para']);
function canSearchHymnExcerpt(artist, track) {
    if (normalize(artist) !== 'harpa crista' || /\d|\/|\+/.test(track)) return false;
    const words = normalize(track).split(' ');
    return words.length >= 4 && words.length <= 16 &&
        new Set(words.filter(word => word.length >= 4 && !COMMON.has(word))).size >= 2;
}
function matchesHymnExcerpt(artist, track, content) {
    if (!canSearchHymnExcerpt(artist, track) || typeof content !== 'string') return false;
    // Accept the common "e/es" transcription variation, but no fuzzy song or hymn-number substitutions.
    const phrase = value => normalize(value).replace(/\bes\b/g, 'e');
    const requested = phrase(track);
    return content.split(/\r?\n/).some(line => {
        const words = phrase(line);
        return (` ${words} `).includes(` ${requested} `);
    });
}
module.exports = {canSearchHymnExcerpt, matchesHymnExcerpt};
