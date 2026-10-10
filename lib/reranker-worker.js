const {parentPort, workerData} = require('node:worker_threads');
const path = require('node:path');

async function main() {
    const {AutoTokenizer, AutoModelForSequenceClassification, env} = await import('@huggingface/transformers');
    env.cacheDir = workerData.cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = workerData.allowDownload === true;
    const modelId = 'SugoLabs/mmarco-mMiniLMv2-L12-H384-v1';
    const revision = '6772eee1ea62dc82e1fcaaf3ed90c269fdcb1fcf';
    const localFilesOnly = workerData.allowDownload !== true;
    // The tokenizer metadata probe ignores revision; use the pinned directory offline.
    const source = localFilesOnly ? path.join(workerData.cacheDir, modelId, revision) : modelId;
    const tokenizer = await AutoTokenizer.from_pretrained(source, {revision, local_files_only: localFilesOnly});
    const model = await AutoModelForSequenceClassification.from_pretrained(source,
        {revision, local_files_only: localFilesOnly, dtype: 'q8',
            session_options: {intraOpNumThreads: 1, interOpNumThreads: 1}});
    await model(tokenizer(['musica'], {text_pair: ['titulo artista'], padding: true, truncation: true, max_length: 128}));
    parentPort.on('message', async ({id, query, documents}) => {
        try {
            const inputs = tokenizer(documents.map(() => query), {text_pair: documents,
                padding: true, truncation: true, max_length: 128});
            const output = await model(inputs);
            const scores = Array.from(output.logits.data, Number);
            parentPort.postMessage({id, scores});
        } catch (error) { parentPort.postMessage({id, error: String(error.message).slice(0, 150)}); }
    });
    parentPort.postMessage({ready: true, model: modelId, revision});
}
main().catch(error => { parentPort.postMessage({fatal: String(error.message).slice(0, 180)}); process.exitCode = 1; });
