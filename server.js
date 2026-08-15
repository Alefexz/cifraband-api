// cifra_band/functions/server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// 1. SISTEMA DE CACHE EM MEMÓRIA (Extremamente rápido)
const cache = {};

// 2. FUNÇÃO INTELIGENTE DE SLUG (Para ir na URL exata)
function formatSlug(text) {
    return text.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Tira acentos
        .replace(/[^a-z0-9 ]/g, '') // Tira caracteres especiais
        .trim()
        .replace(/\s+/g, '-'); // Troca espaços por traços
}

app.get('/searchSong', async (req, res) => {
    const artist = req.query.artist;
    const track = req.query.track;

    if (!artist || !track) {
        return res.status(400).send('Informe artist e track.');
    }

    // 3. CHECAGEM DE CACHE
    const cacheKey = `${formatSlug(artist)}-${formatSlug(track)}`;
    if (cache[cacheKey]) {
        console.log(`⚡ Cifra servida do Cache: ${track}`);
        return res.status(200).json(cache[cacheKey]);
    }

    try {
        const artistSlug = formatSlug(artist);
        const trackSlug = formatSlug(track);
        
        // 4. URL EXATA (Evita erro de pegar a música errada no resultado da busca)
        const songUrl = `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}/`;

        // 5. TIMEOUT DE SEGURANÇA (Máximo de 8 segundos)
        const songResponse = await axios.get(songUrl, { timeout: 8000 });
        const $ = cheerio.load(songResponse.data);

        // 6. EXTRAÇÃO EXATA (Diferencia Tom de Capo perfeitamente)
        const content = $('pre').first().text() || '';
        const key = $('#cifra_tom a').text() || '';
        let capo = $('#cifra_capo a').text() || '';
        capo = capo.replace('ª', '');

        if (!content) {
            return res.status(404).send('Cifra não encontrada no Cifra Club.');
        }

        // Limpeza de tags inúteis do Cifra Club
        let cleanContent = content
            .replace(/\[\/?(b|i)\]/g, '')
            .split('\n')
            .filter(line => line.trim() !== '')
            .join('\n');

        const finalResult = {
            title: track,
            artist: artist,
            originalKey: key,
            capo: capo,
            shapeKey: key, // O Transposer Engine do Dart lida com a diferença lá no Front
            content: cleanContent,
            url: songUrl
        };

        // Salva no Cache para a próxima vez
        cache[cacheKey] = finalResult;

        res.status(200).json(finalResult);

    } catch (error) {
        console.error(`❌ Erro na raspagem de ${track}:`, error.message);
        // Se der erro 404, significa que o músico digitou o nome errado
        res.status(404).send('Cifra não encontrada. Verifique se o nome está escrito corretamente.');
    }
});

app.listen(port, () => {
    console.log(`Servidor CifraBand V3-Lite rodando na porta ${port}`);
});