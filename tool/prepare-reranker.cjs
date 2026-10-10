// Explicit preparation: model weights stay on the server/computer, never in the APK.
const {createLocalScorer} = require('../lib/candidate-reranker');
async function main() {
    const cachedOnly = process.argv.includes('--cached');
    const scorer = createLocalScorer({mode: 'on', allowDownload: !cachedOnly,
        startupTimeout: cachedOnly ? 60000 : 600000});
    const started = Date.now();
    scorer.start();
    try {
        while (['not_started', 'loading'].includes(scorer.status())) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            console.log(JSON.stringify({phase: scorer.status(), elapsedMs: Date.now() - started}));
        }
        if (scorer.status() !== 'ready') throw Error(`Model preparation failed: ${scorer.status()} ${scorer.detail()}`);
        for (const query of ['corinho de fogo midian lima', 'joao viu lauriete']) {
            const documents = query.includes('midian')
                ? ['Corinhos de Fogo - Midian Lima', 'Prioridade - Midian Lima']
                : ['Joao Viu - Lauriete', 'Deus dos Deuses - Lauriete'];
            // Warm-up is outside user requests; a ready scorer still has a strict per-query budget.
            for (let attempt = 0; attempt < 2; attempt++) {
                const before = Date.now();
                const scores = await scorer.score(query, documents);
                if (!scores || scores.some(n => !Number.isFinite(n))) throw Error('Model returned no valid scores');
                if (scores.length !== documents.length || scores[0] <= scores[1]) throw Error('Expected song did not rank first');
                console.log(JSON.stringify({query, documents, scores, elapsedMs: Date.now() - before, attempt}));
            }
        }
    } finally { await scorer.stop(); }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
