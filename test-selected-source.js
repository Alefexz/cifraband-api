const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {findSong} = require('./server');

test('selected URL is opened first, validated, and returned without slug guessing', async () => {
    const original = axios.get, calls = [];
    const url = 'https://www.cifraclub.com.br/artista-teste/endereco-diferente/';
    try {
        axios.get = async address => {
            calls.push(address);
            return {status: 200, data: '<h1>Canto Teste</h1><h2><a>Artista Teste</a></h2>' +
                '<pre>C G Am F\nUma frase para cantar\nOutra frase para tocar</pre>'};
        };
        const result = await findSong('Artista Teste', 'Canto Teste', {sourceUrl: url});
        assert.equal(result.title, 'Canto Teste');
        assert.equal(result.url, url);
        assert.deepEqual(calls, [url]);
    } finally { axios.get = original; }
});
