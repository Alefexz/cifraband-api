// test-search.js
// Roda uma bateria de casos de teste contra a API /searchSong e mostra
// um relatório de pass/fail com o tempo de cada busca.
//
// Uso:
//   FIREBASE_ID_TOKEN=... node test-search.js
//   FIREBASE_WEB_API_KEY=... node test-search.js
//   API_BASE=http://localhost:3000 FIREBASE_ID_TOKEN=... node test-search.js
//
// Depende só do axios, que o projeto já usa.

const axios = require('axios');

const API_BASE = process.env.API_BASE || 'https://cifraband-api.onrender.com';
const SLOW_THRESHOLD_MS = 15000; // acima disso, avisa mesmo quando acha

const TEST_CASES = [
  // ── Regressão: casos que já sabemos que funcionavam ──
  { category: 'Culto real / artista vindo do catálogo', artist: 'Gabriel Guedes de Almeida', track: 'Santo pra Sempre (Ao Vivo)' },
  { category: 'Culto real / artista vindo do catálogo', artist: 'Gabriel Guedes de Almeida', track: 'Vitorioso És (Ao Vivo)' },
  { category: 'Culto real / artista vindo do catálogo', artist: 'Gabriel Guedes de Almeida & Nivea Soares', track: 'A Bênção' },

  // ── Fallback multi-provedor: existem em outros sites ou slugs alternativos ──
  { category: 'Fallback multi-provedor', artist: 'Isadora Pompeo', track: 'Ovelha Em Treinamento' },
  { category: 'Fallback multi-provedor', artist: 'Kemuel', track: 'Algo Novo (feat. Lukas Agustinho)' },
  { category: 'Fallback multi-provedor', artist: 'Kemuel', track: 'Aba' },
  { category: 'Fallback multi-provedor', artist: 'Kellen Byanca', track: 'Por Causa Dele' },
  { category: 'Fallback multi-provedor', artist: 'Gabriela Rocha', track: 'Diz' },
  { category: 'Fallback multi-provedor', artist: 'Isadora Pompeo', track: 'Tetelestai (Ao Vivo) (feat. Carol Tauber)' },

  // ── Regressão: casos que já sabemos que funcionavam ──
  { category: 'Regressão', artist: 'Morada', track: 'É Tudo Sobre Você (Ao Vivo)' },
  { category: 'Regressão', artist: 'Morada', track: 'Quero Agradecer (Ao Vivo)' },
  { category: 'Regressão', artist: 'Aline Barros', track: 'Para Sempre Te Adorarei (Ao Vivo)' },
  { category: 'Regressão', artist: 'Aline Barros', track: 'Renova-Me (Ao Vivo)' },
  { category: 'Regressão', artist: 'fhop music', track: 'Meia Noite (Ao Vivo)' },

  // ── Título abreviado / precisa do catálogo do artista ──
  { category: 'Título abreviado / catálogo', artist: 'Aline Barros', track: 'Dança do Pinguim' },
  { category: 'Título abreviado / catálogo', artist: 'Aline Barros', track: 'Homenzinho Torto' },

  // ── Score ficava abaixo do limiar de uma etapa e era descartado ──
  { category: 'Score baixo (fallback da etapa 4)', artist: 'Aline Barros', track: 'Primeira Essência (Jardim Particular) (Ao Vivo)' },
  { category: 'Score baixo (fallback da etapa 4)', artist: 'Aline Barros', track: 'Rendido Estou (Arms Open Wide) (Ao Vivo)' },

  // ── Prefixo de artista duplicado dentro do track ──
  { category: 'Prefixo duplicado (rede de segurança)', artist: 'Aline Barros', track: 'Aline Barros - Dança do Pinguim' },

  // ── Slug de artista que nenhuma heurística adivinha ──
  { category: 'Slug de artista imprevisível', artist: 'Nadson O Ferinha', track: 'Mande um Sinal' },
  { category: 'Slug de artista imprevisível', artist: 'Nadson O Ferinha', track: 'Sinal' },
  { category: 'Slug de artista imprevisível', artist: 'Nadson O Ferinha', track: 'Duas' },

  // ── Múltiplos artistas / colaboração ──
  { category: 'Colaboração / múltiplos artistas', artist: 'fhop music & Marco Telles', track: 'Colossenses e Suas Linhas de Amor' },
  { category: 'Colaboração / múltiplos artistas', artist: 'fhop music, Débora Rabelo & Hamilton Rabelo', track: 'Tu és + Águas Purificadoras (Ao Vivo)' },

  // ── Acentos — NÃO verificado ao vivo contra o Cifra Club, pode não existir exatamente assim ──
  { category: 'Acentos (não verificado)', artist: 'Isaías Saad', track: 'Ainda Que a Figueira' },

  // ── Nome de artista ambíguo/abreviado — NÃO verificado ao vivo ──
  { category: 'Nome ambíguo (não verificado)', artist: 'Aline', track: 'Dança do Pinguim' },

  // ── Negativo: não deve existir — só confirma que falha rápido, sem travar ──
  { category: 'Negativo — deve falhar rápido', artist: 'Artista Que Não Existe XYZ123', track: 'Música Inventada ABC789', expectFail: true },
];

async function getAuthHeaders() {
  if (process.env.FIREBASE_ID_TOKEN) {
    return {
      Authorization: `Bearer ${process.env.FIREBASE_ID_TOKEN}`
    };
  }

  if (!process.env.FIREBASE_WEB_API_KEY) {
    return {};
  }

  const response = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${process.env.FIREBASE_WEB_API_KEY}`,
    { returnSecureToken: true },
    { timeout: 20000 }
  );

  return {
    Authorization: `Bearer ${response.data.idToken}`
  };
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function runOne(testCase, headers) {
  const start = Date.now();
  try {
    const response = await axios.get(`${API_BASE}/searchSong`, {
      params: { artist: testCase.artist, track: testCase.track },
      headers,
      timeout: 60000,
      validateStatus: () => true
    });
    const elapsed = Date.now() - start;

    if (testCase.expectFail) {
      const ok = response.status === 404;
      return {
        ...testCase,
        ok,
        elapsed,
        detail: ok ? 'falhou como esperado (404)' : `esperava 404, veio ${response.status}`
      };
    }

    if (response.status !== 200) {
      return {
        ...testCase,
        ok: false,
        elapsed,
        detail: `HTTP ${response.status} — ${response.data?.message || response.data?.error || ''}`
      };
    }

    const data = response.data;
    return {
      ...testCase,
      ok: true,
      elapsed,
      detail: `"${data.title}" — ${data.artist} — tom ${data.originalKey || '?'} — fonte ${data.source || '?'} — score ${data.searchScore}`
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    return { ...testCase, ok: false, elapsed, detail: `erro de rede: ${error.message}` };
  }
}

async function main() {
  console.log(`Testando contra: ${API_BASE}\n`);
  const headers = await getAuthHeaders();

  if (!headers.Authorization) {
    console.log('Aviso: sem FIREBASE_ID_TOKEN ou FIREBASE_WEB_API_KEY. A API em produção deve retornar 401.\n');
  }

  let passed = 0;
  let failed = 0;
  let currentCategory = null;

  for (const testCase of TEST_CASES) {
    if (testCase.category !== currentCategory) {
      currentCategory = testCase.category;
      console.log(`\n── ${currentCategory} ──`);
    }

    const result = await runOne(testCase, headers);
    const icon = result.ok ? '✅' : '❌';
    const timeTag =
      result.elapsed > SLOW_THRESHOLD_MS
        ? `  ⚠️ lento (${formatMs(result.elapsed)})`
        : ` (${formatMs(result.elapsed)})`;

    console.log(`${icon} ${result.artist} — ${result.track}${timeTag}`);
    console.log(`   ${result.detail}`);

    if (result.ok) passed++;
    else failed++;
  }

  console.log(`\n════════════════════════════════`);
  console.log(`${passed}/${passed + failed} passaram`);
  console.log(`════════════════════════════════`);
}

main();
