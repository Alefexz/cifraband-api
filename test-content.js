const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { analyzeChordContent, extractChordContent, extractWordpressChordContent } = require('./lib/chord-content');
const complete = 'C G Am F\nUma letra para testar\nOutra linha para cantar';
const tabs = '[Tab - Intro]\nParte 1 de 2\nC D Em Bm\nE|---0--2---|\nB|---3--0---|\n';
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
