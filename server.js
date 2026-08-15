// cifra_band/functions/server.js

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// Função para limpar nomes (ex: "Lugar Secreto" vira "lugar-secreto")
function formatSlug(text) {
    return text.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove acentos
        .replace(/[^a-z0-9 ]/g, '') // Remove caracteres especiais
        .replace(/\s+/g, '-'); // Troca espaço por traço
}

app.get('/searchSong', async (req, res) => {
    const artist = req.query.artist;
    const track = req.query.track;

    if (!artist || !track) {
        return res.status(400).send('Informe artist e track.');
    }

    try {
        const artistSlug = formatSlug(artist);
        const trackSlug = formatSlug(track);
        
        // Acessa o Cifra Club diretamente pela URL
        const songUrl = `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}/`;

        const songResponse = await axios.get(songUrl);
        const $ = cheerio.load(songResponse.data);

        const content = $('pre').first().text() || '';
        const key = $('#cifra_tom a').text() || '';
        let capo = $('#cifra_capo a').text() || '';
        capo = capo.replace('ª', '');

        if (!content) {
            return res.status(404).send('Cifra não encontrada no Cifra Club.');
        }

        // Limpa o conteúdo extraído
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
            shapeKey: key,
            content: cleanContent,
            url: songUrl
        };

        res.status(200).json(finalResult);

    } catch (error) {
        console.error('Erro na raspagem:', error.message);
        res.status(404).send('Cifra não encontrada ou URL inválida.');
    }
});

app.listen(port, () => {
    console.log(`Servidor CifraBand rodando na porta ${port}`);
});