const {analyzeChordContent} = require('./chord-content');
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const title = value => normalize(String(value || '').replace(/\((?:ao vivo|live)\)/gi, ''));

// Conservative audit acceptance, independent from the resolver's ranking score.
function validateSearchResponse(status, data, requested) {
    if (status !== 200) return {ok: false, reason: `http_${status}`};
    if (!data || !analyzeChordContent(data.content).usable) return {ok: false, reason: 'content_rejected'};
    if (!normalize(requested.artist) || normalize(data.artist) !== normalize(requested.artist)) {
        return {ok: false, reason: 'artist_mismatch'};
    }
    if (!title(requested.track) || title(data.title) !== title(requested.track)) {
        return {ok: false, reason: 'title_mismatch'};
    }
    return {ok: true, reason: 'accepted'};
}
module.exports = {validateSearchResponse};
