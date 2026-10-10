const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateSearchResponse: validate} = require('./lib/search-acceptance');
const request = {artist: 'Artista Teste', track: 'Canto Teste'};
const valid = {artist: request.artist, title: request.track,
    content: 'C G Am F\nUma frase somente para teste\nOutra frase sintetica para teste'};
test('200 requires lyrics chords and both identities', () => {
    assert.equal(validate(200, valid, request).ok, true);
    for (const data of [{}, {...valid, content: 'C G'}, {...valid, artist: 'Outro'},
        {...valid, title: 'Outro'}, {...valid, title: ''}]) assert.equal(validate(200, data, request).ok, false);
    assert.equal(validate(503, valid, request).ok, false);
});
test('does not turn a partial medley into a success', () => {
    assert.equal(validate(200, valid, {...request, track: 'Canto Teste / Outra Parte'}).ok, false);
});
