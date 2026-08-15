// cifra_band/functions/server.js

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const port = process.env.PORT || 3000;

app.get('/searchSong', async (req, res) => {
    const artist = req.query.artist;
    const track = req.query.track;

    if (!artist || !track) {
        return res.status(400).send('Informe artist e track.');
    }

    let browser;
    try {
        // O Render precisa desse --no-sandbox para rodar o Puppeteer
        browser = await puppeteer.launch({ 
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        });
        
        const page = await browser.newPage();
        
        const searchQuery = `${track} ${artist}`.replace(/ /g, '-').toLowerCase();
        const searchUrl = `https://www.cifraclub.com.br/?q=${searchQuery}`;
        
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

        // Pega o primeiro link da busca
        const songUrl = await page.evaluate(() => {
            const firstResult = document.querySelector('.gsc-thumbnail-inside a.gs-title');
            return firstResult ? firstResult.href : null;
        });

        if (!songUrl) {
            await browser.close();
            return res.status(404).send('Cifra não encontrada no Cifra Club.');
        }

        // Abre a página da cifra
        await page.goto(songUrl, { waitUntil: 'domcontentloaded' });

        // Extrai o conteúdo e os dados
        const songData = await page.evaluate(() => {
            const preElement = document.querySelector('pre');
            const keyElement = document.querySelector('#cifra_tom a');
            const capoElement = document.querySelector('#cifra_capo a');
            
            const content = preElement ? preElement.innerText : '';
            const key = keyElement ? keyElement.innerText : '';
            const capo = capoElement ? capoElement.innerText.replace('ª', '') : '';
            
            return { content, key, capo };
        });

        await browser.close();

        // Limpa o conteúdo extraído
        let cleanContent = songData.content
            .replace(/\[\/?(b|i)\]/g, '') // Remove tags do Cifra Club
            .split('\n')
            .filter(line => line.trim() !== '') // Remove linhas em branco
            .join('\n');

        const finalResult = {
            title: track,
            artist: artist,
            originalKey: songData.key,
            capo: songData.capo,
            shapeKey: songData.key, 
            content: cleanContent,
            url: songUrl
        };

        res.status(200).json(finalResult);

    } catch (error) {
        if (browser) await browser.close();
        console.error('Erro no servidor:', error);
        res.status(500).send('Erro interno do servidor.');
    }
});

app.listen(port, () => {
    console.log(`Servidor CifraBand rodando na porta ${port}`);
});