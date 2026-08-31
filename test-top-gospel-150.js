// test-top-gospel-150.js
// Monta uma lista atual de ate 150 musicas gospel usando fontes publicas
// do Deezer e testa cada item contra /searchSong.
//
// Uso:
//   FIREBASE_WEB_API_KEY=... node test-top-gospel-150.js
//   LIMIT=150 CONCURRENCY=3 FIREBASE_WEB_API_KEY=... node test-top-gospel-150.js

const axios = require('axios');

const API_BASE = process.env.API_BASE || 'https://cifraband-api.onrender.com';
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
const LIMIT = Number(process.env.LIMIT || 150);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90000);
const TOKEN_COUNT = Number(process.env.TOKEN_COUNT || 4);

const DEEZER_PLAYLISTS = [
  {
    id: '4835783228',
    label: 'Deezer playlist: Gospel Mais Tocadas 2026 | Lançamentos Gospel 2026',
    url: 'https://www.deezer.com/playlist/4835783228',
    api: 'https://api.deezer.com/playlist/4835783228/tracks?limit=100'
  }
];

const SEARCH_TERMS = [
  'gospel brasil',
  'gospel 2026',
  'louvor gospel',
  'adoracao gospel',
  'musica gospel brasileira',
  'worship brasil',
  'todah music',
  'som do reino',
  'morada gospel',
  'fernandinho gospel',
  'isaias saad',
  'gabriel guedes',
  'fhop music',
  'aline barros',
  'isadora pompeo',
  'casa worship',
  'diante do trono',
  'preto no branco',
  'bruna karla',
  'midian lima',
  'julliany souza',
  'gabriela rocha',
  'leandro borges',
  'kemuel',
  'victin',
  'pedro henrique gospel'
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTrackTitle(track) {
  return String(track?.title_short || track?.title || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtistName(track) {
  return String(track?.artist?.name || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function itemKey(item) {
  return `${normalizeText(item.artist)}::${normalizeText(item.track)}`;
}

function pushTrack(map, track, source, weight = 0) {
  const title = cleanTrackTitle(track);
  const artist = cleanArtistName(track);

  if (!title || !artist) return;

  const item = {
    artist,
    track: title,
    rank: Number(track.rank || 0),
    source,
    score: Number(track.rank || 0) + weight
  };

  const key = itemKey(item);
  const current = map.get(key);

  if (!current || item.score > current.score) {
    map.set(key, item);
  }
}

async function fetchPlaylistTracks() {
  const map = new Map();

  for (const playlist of DEEZER_PLAYLISTS) {
    try {
      const response = await axios.get(playlist.api, { timeout: 20000 });
      const tracks = response.data?.data || [];
      tracks.forEach((track, index) => {
        pushTrack(map, track, playlist.label, 1_000_000 - index);
      });
      console.log(`Fonte: ${playlist.label} -> ${tracks.length} musicas`);
    } catch (error) {
      console.log(`Fonte falhou: ${playlist.label} -> ${error.message}`);
    }
  }

  return [...map.values()];
}

async function fetchSearchTracks() {
  const map = new Map();

  for (const term of SEARCH_TERMS) {
    try {
      const response = await axios.get('https://api.deezer.com/search/track', {
        timeout: 20000,
        params: {
          q: term,
          order: 'RANKING',
          limit: 100
        }
      });

      const tracks = response.data?.data || [];
      tracks.forEach(track => {
        pushTrack(map, track, `Deezer search: ${term}`);
      });
      console.log(`Fonte: busca "${term}" -> ${tracks.length} musicas`);
    } catch (error) {
      console.log(`Busca falhou: ${term} -> ${error.message}`);
    }
  }

  return [...map.values()];
}

async function buildTopList() {
  const all = [
    ...(await fetchPlaylistTracks()),
    ...(await fetchSearchTracks())
  ];

  const unique = new Map();

  for (const item of all) {
    const key = itemKey(item);
    const current = unique.get(key);
    if (!current || item.score > current.score) {
      unique.set(key, item);
    }
  }

  return [...unique.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);
}

async function createFirebaseToken() {
  if (!FIREBASE_WEB_API_KEY) {
    throw new Error('Defina FIREBASE_WEB_API_KEY para autenticar na API.');
  }

  const response = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_WEB_API_KEY}`,
    { returnSecureToken: true },
    { timeout: 20000 }
  );

  return response.data.idToken;
}

async function createTokenPool() {
  const tokens = [];
  for (let i = 0; i < TOKEN_COUNT; i++) {
    tokens.push(await createFirebaseToken());
  }
  return tokens;
}

async function testSong(item, token, index) {
  const startedAt = Date.now();
  const response = await axios.get(`${API_BASE}/searchSong`, {
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    params: {
      artist: item.artist,
      track: item.track
    },
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const elapsedMs = Date.now() - startedAt;

  if (response.status !== 200) {
    return {
      ok: false,
      index,
      elapsedMs,
      status: response.status,
      requested: item,
      error: response.data?.error || 'http_error',
      message: response.data?.message || ''
    };
  }

  const data = response.data || {};
  const titleOk =
    normalizeText(data.title) === normalizeText(item.track) ||
    normalizeText(data.title).includes(normalizeText(item.track)) ||
    normalizeText(item.track).includes(normalizeText(data.title));

  return {
    ok: true,
    titleOk,
    index,
    elapsedMs,
    requested: item,
    found: {
      title: data.title,
      artist: data.artist,
      key: data.originalKey,
      shapeKey: data.shapeKey,
      capo: data.capo,
      score: data.searchScore,
      url: data.url,
      source: data.source
    }
  };
}

async function runPool(items, tokens) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker(workerIndex) {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;

      const item = items[index];
      const token = tokens[index % tokens.length];

      try {
        const result = await testSong(item, token, index + 1);
        results[index] = result;
        const icon = result.ok ? (result.titleOk ? 'OK' : 'SUSPEITO') : 'FAIL';
        const time = `${(result.elapsedMs / 1000).toFixed(1)}s`;
        const found = result.ok
          ? `=> ${result.found.title} - ${result.found.artist} | tom ${result.found.key || '?'} | fonte ${result.found.source || '?'} | score ${result.found.score}`
          : `=> HTTP ${result.status} ${result.error}`;
        console.log(`${String(index + 1).padStart(3, '0')} [${icon}] ${item.artist} - ${item.track} (${time}) ${found}`);
      } catch (error) {
        results[index] = {
          ok: false,
          index: index + 1,
          elapsedMs: 0,
          requested: item,
          error: 'exception',
          message: error.message
        };
        console.log(`${String(index + 1).padStart(3, '0')} [FAIL] ${item.artist} - ${item.track} => ${error.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, (_, index) =>
      worker(index)
    )
  );

  return results;
}

function printSummary(results) {
  const ok = results.filter(item => item?.ok);
  const fail = results.filter(item => item && !item.ok);
  const suspicious = ok.filter(item => !item.titleOk);
  const slow = results
    .filter(item => item && item.elapsedMs > 15000)
    .sort((a, b) => b.elapsedMs - a.elapsedMs);

  console.log('\n================ RESUMO ================');
  console.log(`Total testado: ${results.length}`);
  console.log(`Encontradas: ${ok.length}`);
  console.log(`Falhas/404/erros: ${fail.length}`);
  console.log(`Suspeitas por titulo diferente: ${suspicious.length}`);
  console.log(`Taxa bruta de acerto: ${((ok.length / results.length) * 100).toFixed(1)}%`);
  console.log('========================================\n');

  if (fail.length) {
    console.log('--- FALHAS ---');
    fail.slice(0, 80).forEach(item => {
      console.log(`${item.index}. ${item.requested.artist} - ${item.requested.track} | ${item.error} ${item.message}`);
    });
  }

  if (suspicious.length) {
    console.log('\n--- SUSPEITAS ---');
    suspicious.slice(0, 80).forEach(item => {
      console.log(`${item.index}. Pediu: ${item.requested.artist} - ${item.requested.track}`);
      console.log(`   Veio: ${item.found.artist} - ${item.found.title} | ${item.found.url}`);
    });
  }

  if (slow.length) {
    console.log('\n--- LENTAS (>15s) ---');
    slow.slice(0, 40).forEach(item => {
      console.log(`${item.index}. ${item.requested.artist} - ${item.requested.track} | ${(item.elapsedMs / 1000).toFixed(1)}s`);
    });
  }
}

async function main() {
  console.log(`API: ${API_BASE}`);
  console.log(`Limite: ${LIMIT}`);
  console.log(`Concorrencia: ${CONCURRENCY}`);
  console.log('');

  const items = await buildTopList();
  console.log(`\nLista final deduplicada: ${items.length} musicas\n`);

  const tokens = await createTokenPool();
  const results = await runPool(items, tokens);
  printSummary(results);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
