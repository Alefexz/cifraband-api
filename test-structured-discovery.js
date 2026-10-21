const {test} = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {createStructuredDiscovery, parseDiscovery, discoveryQueries, numberedHymnMatch} = require('./lib/structured-discovery');
const payload = docs => '(' + JSON.stringify({response: {docs}}) + ')';
const hit = {t: '2', a: 'Harpa Crista', m: 'Porque Ele Vive - 545', d: 'harpa-crista', u: 'porque-ele-vive'};

test('JSONP is parsed as data, not evaluated; invalid paths/types excluded', () => {
    assert.equal(parseDiscovery(payload([hit, {...hit,u:'../../private'}, {...hit,t:'1'}])).length, 1);
    assert.throws(() => parseDiscovery('callback(' + payload([hit]) + ')'));
    assert.throws(() => parseDiscovery('<html>Forbidden</html>'));
    assert.throws(() => parseDiscovery('x'.repeat(500001)));
});
test('hymn number is exact and bounded to the requested hymnal', () => {
    assert.equal(numberedHymnMatch('Harpa Crista', 'Hino 545', hit.m), true);
    assert.equal(numberedHymnMatch('Harpa Crista', '545', 'Hino 546'), false);
    assert.equal(numberedHymnMatch('Outro artista', '545', hit.m), false);
    assert.equal(numberedHymnMatch('Harpa Crista', '0', 'Hino 0'), false);
    assert.equal(numberedHymnMatch('Harpa Crista', '545', '545 / 546'), false);
    assert.equal(discoveryQueries('Harpa Crista', 'Hino 545')[0], 'Harpa Crista 545');
});
test('discovery filters other artists and wrong hymn numbers', async () => {
    const discover = createStructuredDiscovery({get: async () => ({status:200, data:payload([
        hit, {...hit,a:'Outra Banda'}, {...hit,m:'Hino 546',u:'hino-546'}])})});
    const results = await discover('Harpa Crista', '545');
    assert.deepEqual(results.map(r => r.title), [hit.m]);
});
test('positive metadata cache avoids repeating requests; failures are not cached', async () => {
    let calls = 0;
    const discover = createStructuredDiscovery({get: async () => { calls++; return {status:200,data:payload([hit])}; }});
    await discover('Harpa Crista', '545'); await discover('Harpa Crista', '545');
    assert.equal(calls, 1);
    let failures = 0;
    const unavailable = createStructuredDiscovery({get: async () => {
        failures++; throw Object.assign(Error('blocked'), {response:{status:403}});
    }});
    await unavailable('Harpa Crista','545'); await unavailable('Harpa Crista','545');
    assert.equal(failures, 2);
});
test('resolver delivers numbered hymn from discovered URL and rejects another number', async () => {
    const {findSong,isSearchResultSafeForRequest} = require('./server');
    const original = axios.get;
    const content = 'C G Am F\nUma frase para cantar\nOutra frase para tocar';
    try {
        axios.get = async url => {
            if(url.startsWith('https://solr.sscdn.co/')) return {status:200,data:payload([hit])};
            if(url === 'https://www.cifraclub.com.br/harpa-crista/porque-ele-vive/') return {
                status:200,data:`<h1>${hit.m}</h1><h2><a>Harpa Crista</a></h2><pre>${content}</pre>`};
            throw Object.assign(Error('missing'), {response:{status:404}});
        };
        const result = await findSong('Harpa Crista','545');
        assert.equal(result.title,hit.m);
        assert.equal(isSearchResultSafeForRequest('Harpa Crista','546',result),false);
    } finally {axios.get=original;}
});

test('discovered full medley is validated; metadata alone never becomes a chart', async () => {
    const {findSong} = require('./server');
    const original = axios.get;
    const medley = {t:'2',a:'Artista Sintetico',m:'Primeiro Canto / Segundo Canto',
        d:'artista-sintetico',u:'medley-publicado'};
    const target = 'https://www.cifraclub.com.br/artista-sintetico/medley-publicado/';
    let blocked = false;
    try {
        axios.get = async url => {
            if (url.startsWith('https://solr.sscdn.co/')) return {status:200,data:payload([medley])};
            if (url === target && !blocked) return {status:200,
                data:`<h1>${medley.m}</h1><h2><a>${medley.a}</a></h2><pre>C G Am F\nPrimeiro canto para cantar\nSegundo canto para tocar</pre>`};
            throw Object.assign(Error('blocked'),{response:{status:403}});
        };
        const result = await findSong(medley.a,medley.m);
        assert.equal(result.url,target);
        assert.ok(result.content.includes('Segundo canto'));
        blocked = true;
        await assert.rejects(findSong(medley.a,medley.m), error => error.statusCode === 503);
    } finally {axios.get=original;}
});

test('Gospel Online selected URL uses its published two-part path', async () => {
    const {findSong} = require('./server');
    const original = axios.get;
    const url = 'https://cifrasgospel.online/kelly-silva/a-visao-de-joao/';
    const requested = [];
    try {
        axios.get = async target => {
            requested.push(target);
            assert.equal(target,url);
            return {status:200,data:'<title>A Visao de Joao - Kelly Silva - Cifra Completa Revisada</title><h1>A Visao de Joao</h1><pre>C G Am F\nUma frase sintetica para cantar\nOutra frase sintetica para tocar</pre>'};
        };
        const result = await findSong('Kelly Silva','A Visao de Joao',{sourceUrl:url});
        assert.equal(result.url,url);
        assert.equal(result.source,'cifras_gospel_online');
        assert.deepEqual(requested,[url]);
    } finally {axios.get=original;}
});
