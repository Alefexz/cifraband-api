const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {inspectSongUrl, isSearchResultSafeForRequest} = require('./server');
const content = '<pre>C G Am F\nUma frase para cantar\nOutra frase para tocar</pre>';
async function inspect(html, artist, title) {
    const original = axios.get;
    try {
        axios.get = async () => ({status: 200, data: html});
        return await inspectSongUrl('https://www.cifraclub.com.br/artista/cancao/', artist, title);
    } finally { axios.get = original; }
}
test('current Cifra Club description and navigation heading do not hide the real artist', async () => {
    const result = await inspect('<title>Tu Es Fiel, Senhor - 535 - Harpa Crista - Cifra Club</title>' +
        '<meta name="description" content="Aprenda a tocar a cifra de Tu Es Fiel, Senhor - 535 (Harpa Crista) no Cifra Club">' +
        '<h2>Menu principal</h2><h1>Tu Es Fiel, Senhor - 535</h1><h2>Harpa Crista</h2>' + content,
        'Harpa Crista', 'Tu Es Fiel, Senhor');
    assert.equal(result.artist, 'Harpa Crista');
    assert.equal(result.title, 'Tu Es Fiel, Senhor - 535');
    assert.equal(isSearchResultSafeForRequest('Harpa Crista', 'Tu Es Fiel, Senhor', result), true);
});
test('hyphens in artist and title are not split into fabricated metadata', async () => {
    const result = await inspect('<title>Canto - Ao Vivo - Grupo - Teste - Cifra Club</title>' +
        '<h2>Menu principal</h2><h1>Canto - Ao Vivo</h1>' + content, 'Grupo - Teste', 'Canto - Ao Vivo');
    assert.equal(result.artist, 'Grupo - Teste');
});
test('same title by a different artist is still rejected by final identity validation', async () => {
    const result = await inspect('<title>Canto Fiel - Outro Artista - Cifra Club</title><h1>Canto Fiel</h1>' + content,
        'Artista Solicitado', 'Canto Fiel');
    assert.equal(isSearchResultSafeForRequest('Artista Solicitado', 'Canto Fiel', result), false);
});
test('unrelated document title cannot manufacture an artist for a missing identity', async () => {
    const result = await inspect('<title>Outra Musica - Outro Artista - Cifra Club</title>' +
        '<h2>Menu principal</h2><h1>Canto Fiel</h1>' + content, 'Artista', 'Canto Fiel');
    assert.equal(result, null);
});
