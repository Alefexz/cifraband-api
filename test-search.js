// test-search.js
// Roda uma bateria de casos de teste contra a API /searchSong e mostra
// um relatório de pass/fail com o tempo de cada busca.
//
// Uso:
//   node test-search.js
//   API_BASE=http://localhost:3000 node test-search.js   (pra testar local)
//
// Depende só do axios, que o projeto já usa.

const axios = require('axios');

const API_BASE = process.env.API_BASE || 'https://cifraband-api.onrender.com';
const SLOW_THRESHOLD_MS = 15000; // acima disso, avisa mesmo quando acha

const TEST_CASES = [
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

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function runOne(testCase) {
  const start = Date.now();
  try {
    const response = await axios.get(`${API_BASE}/searchSong`, {
      params: { artist: testCase.artist, track: testCase.track },
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
      detail: `"${data.title}" — ${data.artist} — tom ${data.originalKey || '?'} — score ${data.searchScore}`
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    return { ...testCase, ok: false, elapsed, detail: `erro de rede: ${error.message}` };
  }
}

async function main() {
  console.log(`Testando contra: ${API_BASE}\n`);

  let passed = 0;
  let failed = 0;
  let currentCategory = null;

  for (const testCase of TEST_CASES) {
    if (testCase.category !== currentCategory) {
      currentCategory = testCase.category;
      console.log(`\n── ${currentCategory} ──`);
    }

    const result = await runOne(testCase);
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
