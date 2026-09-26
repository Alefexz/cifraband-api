const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { analyzeChordContent, extractChordContent, extractWordpressChordContent } = require('./lib/chord-content');
const complete = 'C G Am F\nUma letra para testar\nOutra linha para cantar';
const tabs = '[Tab - Intro]\nParte 1 de 2\nC D Em Bm\nE|---0--2---|\nB|---3--0---|\n';
test('LosAcordes uses declared title artist key and legacy text encoding', async () => {
    const axios = require('axios');
    const {inspectAlternativeProviderUrl} = require('./server');
    const original = axios.get;
    const provider = {source: 'los_acordes', hostnames: new Set(['www.losacordes.com']), pathPrefix: '/acordes/', responseEncoding: 'latin1'};
    try {
        axios.get = async (_, options) => {
            assert.equal(options.responseEncoding, 'latin1');
            return {status: 200, data: '<title>MEDLEY - CORINHOS DE FOGO Acordes - Midian Lima | LosAcordes.com</title><body>Tono: Bm<pre id="core">Bm G F#\nUma canção para testar\nOutra frase para cantar</pre></body>'};
        };
        const result = await inspectAlternativeProviderUrl('https://www.losacordes.com/acordes/midian-lima/medley-corinhos-de-fogo/', provider, 'Midian Lima', 'Medley - Corinhos de Fogo');
        assert.equal(result.artist, 'Midian Lima');
        assert.equal(result.originalKey, 'Bm');
        assert.ok(result.content.includes('canção'));
        axios.get = async () => ({status: 200, data: '<title>GALILEU Acordes - Fernandinho | LosAcordes.com</title><body>Tono: C#\n<div class="cifra">Publicidade fora do conteudo<pre id="core">Bbm F# C#\nUma canção para testar\nOutra frase para cantar</pre></div></body>'});
        const sharp = await inspectAlternativeProviderUrl('https://www.losacordes.com/acordes/fernandinho/galileu/', provider, 'Fernandinho', 'Galileu');
        assert.equal(sharp.originalKey, 'C#');
        assert.equal(sharp.content.includes('Publicidade'), false);
        axios.get = async () => ({status: 200, data: '<title>ARTIST INDEX</title><pre>C G\nUma letra para testar\nOutra frase para cantar</pre>'});
        assert.equal(await inspectAlternativeProviderUrl('https://www.losacordes.com/acordes/midian-lima/wrong/', provider, 'Midian Lima', 'Medley - Corinhos de Fogo'), null);
    } finally { axios.get = original; }
});
test('rejects tabs, chords alone, lyrics alone and empty text', () => {
    for (const content of [tabs, 'C G Am F\nC7M D/F# Em7', 'Uma letra para testar\nOutra linha para cantar', '']) {
        assert.equal(analyzeChordContent(content).usable, false);
    }
});
test('long tablature cannot override a shorter complete song', () => {
    const $ = cheerio.load(`<aside><pre>${tabs.repeat(30)}</pre></aside><main><pre>${complete}</pre></main>`);
    assert.equal(extractChordContent($), complete);
});
test('preserves HTML br line breaks and chord alignment', () => {
    const $ = cheerio.load('<pre>  C    G<br>Uma letra para testar<br>Am    F<br>Outra linha para cantar</pre>');
    const content = extractChordContent($);
    assert.equal(analyzeChordContent(content).lyricLines, 2);
    assert.ok(content.includes('Am    F\nOutra'));
});
test('combines sibling verse blocks in original order', () => {
    const $ = cheerio.load('<article><pre>C G\nUma letra para testar</pre><pre>Am F\nOutra linha para cantar</pre></article>');
    assert.equal(extractChordContent($), 'C G\nUma letra para testar\n\nAm F\nOutra linha para cantar');
});
test('single pre inside main is not duplicated', () => {
    assert.equal(extractChordContent(cheerio.load(`<main><article><pre>${complete}</pre></article></main>`)), complete);
});
test('tab-only HTML returns no complete result', () => {
    assert.equal(extractChordContent(cheerio.load(`<pre>${tabs}</pre>`)), '');
});

test('Cifras Gospel keeps alternating chord pre and lyric paragraphs', () => {
    const $ = cheerio.load('<div class="entry-content"><pre class="wp-block-verse">   C    G</pre><p class="wp-block-paragraph">Uma letra para testar</p><pre class="wp-block-verse">Am    F</pre><p class="wp-block-paragraph">Outra linha para cantar</p><details>Publicidade</details></div>');
    const content = extractWordpressChordContent($);
    assert.equal(content, '   C    G\nUma letra para testar\nAm    F\nOutra linha para cantar');
    assert.equal(analyzeChordContent(content).usable, true);
});
