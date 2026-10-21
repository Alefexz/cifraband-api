const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {artistSlugs, parseArtistCatalog, createArtistCatalogDiscovery} = require('./lib/artist-catalog-discovery');
const html = (artist, body) => `<title>${artist} acordes | LosAcordes.com</title>${body}`;
const link = (slug, title) => `<a href="/acordes/harpa-crista/${slug}">${title}</a>`;

test('artist variants preserve conjunction and never reduce to first name', () => {
    assert.deepEqual(artistSlugs('Jorge & Mateus'), ['jorge-e-mateus', 'jorge-mateus']);
    assert.deepEqual(artistSlugs('Harpa Crista'), ['harpa-crista']);
});
test('catalog verifies artist, filters foreign URLs and keeps only song metadata', () => {
    const body = link('teste-535', 'Teste 535') + link('teste-535','Teste 535') +
        '<a href="https://evil.example/acordes/harpa-crista/errada">Errada</a>' +
        '<a href="/acordes/outro-artista/errada">Errada</a>' +
        '<a href="/acordes/harpa-crista/teste?letra=1">Letra</a>';
    const rows = parseArtistCatalog(html('HARPA CRISTA',body),'Harpa Crista','harpa-crista');
    assert.equal(rows.length,1);
    assert.deepEqual(Object.keys(rows[0]).sort(),['artist','title','url']);
    assert.deepEqual(parseArtistCatalog(html('Outro Artista',body),'Harpa Crista','harpa-crista'),[]);
    assert.deepEqual(parseArtistCatalog('<title>Pagina no encontrada</title>'+body,'Harpa Crista','harpa-crista'),[]);
});
test('positive cache is bounded by TTL; failures do not poison discovery', async () => {
    let calls = 0, now = 0, fail = true;
    const discover = createArtistCatalogDiscovery({now:()=>now,ttl:100,get:async(_,config)=>{
        calls++; assert.ok(config.signal); assert.equal(config.maxRedirects,0);
        if (fail) throw Error('network');
        return {status:200,data:html('Harpa Crista',link('teste','Teste'))};
    }});
    assert.deepEqual(await discover('Harpa Crista'),[]);
    fail=false;
    assert.equal((await discover('Harpa Crista')).length,1);
    await discover('Harpa Crista'); assert.equal(calls,2);
    now=101; await discover('Harpa Crista'); assert.equal(calls,3);
});
test('stale metadata remains usable when network fails; artist isolation is enforced', async () => {
    let requests = 0;
    const row={title:'Teste',artist:'Harpa Crista',url:'https://www.losacordes.com/acordes/harpa-crista/teste'};
    const discover = createArtistCatalogDiscovery({index:{artist:async()=>({stale:true,links:[row,{...row,artist:'Outro'}]})},
        get:async()=>{requests++; throw Error('offline');}});
    assert.deepEqual(await discover('Harpa Crista'),[row]);
    assert.deepEqual(await discover('Harpa Crista'),[row]);
    assert.equal(requests,2,'failed refresh must not mark stale metadata fresh for six hours');
});
test('resolver finds a published suffix absent from guessed URLs, validates full chart', async () => {
    const {findSong} = require('./server');
    const original=axios.get;
    const artist='Artista de Teste Catalogo', slug='artista-de-teste-catalogo';
    const url=`https://www.losacordes.com/acordes/${slug}/canto-fiel-edicao-535`;
    const requests=[];
    try {
        axios.get=async target=>{
            requests.push(target);
            if(target===`https://www.losacordes.com/${slug}`) return {status:200,
                data:html(artist,`<a href="${url}">Canto Fiel 535</a>`)};
            if(target===url) return {status:200,data:`<title>Canto Fiel 535 Acordes - ${artist} | LosAcordes.com</title>
                <pre id="core">C G Am F\nUma frase sintetica para cantar\nOutra frase sintetica para tocar</pre>`};
            throw Object.assign(Error('missing'),{response:{status:404}});
        };
        const song=await findSong(artist,'Canto Fiel');
        assert.equal(song.url,url);
        assert.equal(song.source,'los_acordes');
        assert.ok(song.content.includes('Uma frase'));
        assert.ok(requests.length < 10,'catalog should win before brute-force URL guesses');
    } finally {axios.get=original;}
});

test('numbered sequels cannot replace an unnumbered composition', () => {
    const {isSearchResultSafeForRequest} = require('./server');
    const content='C G Am F\nUma frase sintetica para cantar\nOutra frase sintetica para tocar';
    assert.equal(isSearchResultSafeForRequest('Shirley Carvalhaes','Deus Tremendo',{
        artist:'Shirley Carvalhaes',title:'Deus Tremendo II',content}),false);
    assert.equal(isSearchResultSafeForRequest('Shirley Carvalhaes','Deus Tremendo II',{
        artist:'Shirley Carvalhaes',title:'Deus Tremendo II',content}),true);
});

test('a medley containing the requested song does not replace the individual chart', () => {
    const {isSearchResultSafeForRequest} = require('./server');
    const content='C G Am F\nEu navegarei e vou cantar\nFaz chover para nos tocar';
    const result={artist:'Gabriela Rocha',title:'Faz Chover / Eu Navegarei',content};
    assert.equal(isSearchResultSafeForRequest('Gabriela Rocha','Eu Navegarei',result),false);
    assert.equal(isSearchResultSafeForRequest('Gabriela Rocha','Faz Chover / Eu Navegarei',result),true);
});

test('an exact catalog title wins over an alternative arrangement', async () => {
    const {findSong} = require('./server');
    const original=axios.get;
    const artist='Artista Exato',slug='artista-exato';
    const base=`https://www.losacordes.com/acordes/${slug}/`;
    const chart=title=>`<title>${title} Acordes - ${artist} | LosAcordes.com</title><pre id="core">C G Am F\nUma frase sintetica para cantar\nOutra frase sintetica para tocar</pre>`;
    const requests=[];
    try {
        axios.get=async url=>{
            requests.push(url);
            if(url===`https://www.losacordes.com/${slug}`) return {status:200,data:html(artist,
                `<a href="${base}canto-versao-2">Canto de Amor - Versao2</a><a href="${base}endereco-original">Canto de Amor</a>`)};
            if(url===base+'endereco-original') return {status:200,data:chart('Canto de Amor')};
            if(url===base+'canto-versao-2') return {status:200,data:chart('Canto de Amor - Versao2')};
            throw Object.assign(Error('missing'),{response:{status:404}});
        };
        assert.equal((await findSong(artist,'Canto de Amor')).title,'Canto de Amor');
        assert.equal(requests.includes(base+'canto-versao-2'),false);
    } finally {axios.get=original;}
});
