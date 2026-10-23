const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {canSearchHymnExcerpt, matchesHymnExcerpt} = require('./lib/hymn-excerpt');
const {inspectSongUrl, isSearchResultSafeForRequest} = require('./server');

test('hymn excerpt requires a meaningful full phrase, never a short or numeric query', () => {
    assert.equal(canSearchHymnExcerpt('Harpa Crista', 'Dos Vales Es o Lirio'), true);
    for (const track of ['198', '545', 'hino 545', 'Deus', 'Deus e eu', 'Dos Vales / Outra Musica']) {
        assert.equal(canSearchHymnExcerpt('Harpa Crista', track), false);
    }
    assert.equal(canSearchHymnExcerpt('Outro Artista', 'Dos Vales Es o Lirio'), false);
    assert.equal(matchesHymnExcerpt('Harpa Crista', 'Dos Vales Es o Lirio', 'C G\nDos vales e o lirio\nAm F'), true);
    assert.equal(matchesHymnExcerpt('Harpa Crista', 'Dos Vales Es o Lirio', 'Dos vales vem outra flor'), false);
    assert.equal(matchesHymnExcerpt('Harpa Crista', 'Dos Vales Es o Lirio', 'Dos vales\nUm lirio diferente'), false);
});
test('published hymn title is preserved and the actual lyric phrase authorizes an alias', async () => {
    const original = axios.get;
    try {
        axios.get = async () => ({status: 200, data: '<title>Jesus o Bom Amigo - 198 - Harpa Crista - Cifra Club</title>' +
            '<h1>Jesus o Bom Amigo - 198</h1><pre>C G Am F\nDos vales e o lirio\nOutra frase para tocar</pre>'});
        const result = await inspectSongUrl('https://www.cifraclub.com.br/harpa-crista/jesus-bom-amigo-198/',
            'Harpa Crista', 'Dos Vales Es o Lirio');
        assert.equal(result.title, 'Jesus o Bom Amigo - 198');
        assert.equal(result.matchedBy, 'hymn_lyric_excerpt');
        assert.equal(isSearchResultSafeForRequest('Harpa Crista', 'Dos Vales Es o Lirio', result), true);
        assert.equal(isSearchResultSafeForRequest('Harpa Crista', '545', result), false);
        assert.equal(isSearchResultSafeForRequest('Outro Artista', 'Dos Vales Es o Lirio', result), false);
        assert.equal(isSearchResultSafeForRequest('Harpa Crista', 'Dos Vales Es o Lirio',
            {...result, content: 'C G Am F\nUma letra diferente\nOutra frase para tocar'}), false);
    } finally { axios.get = original; }
});
