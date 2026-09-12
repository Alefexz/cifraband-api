const CHORD = /^[A-G][#b]?(?:m|M|maj|min|dim|aug|sus|add|\d|[#b+\-()]|[º°ø*]|\/[A-G][#b]?)*$/;
const LABEL = /^(?:parte\s+\d|tom\s*:|capo|afina|intro|solo|refr[aã]o|verso|ponte|final|repete|sem capotraste|com capotraste)/i;

function analyzeChordContent(content) {
    let lyricLines = 0, words = 0, chords = 0, tabLines = 0;
    for (const raw of String(content || '').split('\n')) {
        const line = raw.replace(/\[[^\]]*\]/g, ' ').trim();
        if (/^[eBGDAE]\s*\|/i.test(line) || /^[\d\s|/\\hp~x().-]+$/i.test(line)) {
            tabLines++;
            continue;
        }
        if (!line || LABEL.test(line)) continue;
        const tokens = line.split(/\s+/);
        chords += tokens.filter(token => CHORD.test(token)).length;
        if (tokens.every(token => CHORD.test(token) || /^[|():/\d.xX-]+$/.test(token))) continue;
        const count = (line.match(/[A-Za-zÀ-ÿ]{2,}/g) || []).length;
        if (count >= 2) { lyricLines++; words += count; }
    }
    return { lyricLines, words, chords, tabLines,
        usable: lyricLines >= 2 && words >= 6 && chords >= 2 };
}

function elementText($, element) {
    const clone = $(element).clone();
    clone.find('script,style,button,nav').remove();
    clone.find('br').replaceWith('\n');
    clone.find('p,div').append('\n');
    return clone.text().replace(/\u00a0/g, ' ').replace(/\r/g, '')
        .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
}

function extractWordpressChordContent($) {
    const candidates = [];
    $('.entry-content, .wp-block-post-content').each((_, container) => {
        const parts = [];
        // Chords live in pre; sung words live in the following paragraph.
        $(container).children('pre.wp-block-verse, p.wp-block-paragraph').each((_, element) => {
            const text = elementText($, element);
            if (!text.trim() || /^(?:btn|tom\s*:|capo|afina)/i.test(text.trim())) return;
            parts.push(text);
        });
        const content = parts.join('\n');
        if (analyzeChordContent(content).usable) candidates.push(content);
    });
    return candidates.sort((a, b) => b.length - a.length)[0] || '';
}

function extractChordContent($) {
    const candidates = [];
    const groups = new Map();
    $('pre').each((_, element) => {
        const text = elementText($, element);
        if (!text) return;
        candidates.push(text);
        // Some providers split verses into sibling pre elements.
        const group = groups.get(element.parent) || [];
        group.push(text);
        groups.set(element.parent, group);
    });
    for (const parts of groups.values()) {
        if (parts.length > 1) candidates.push(parts.join('\n\n'));
    }
    $('.cifra_cnt, .cifra, #cifra, .cifra-content, .chord-content').each((_, element) => {
        candidates.push(elementText($, element));
    });
    return candidates.map(content => ({ content, quality: analyzeChordContent(content) }))
        .filter(item => item.quality.usable)
        .sort((a, b) => b.quality.lyricLines - a.quality.lyricLines || b.content.length - a.content.length)
        [0]?.content || '';
}

function extractLyricText(content) {
    return String(content || '').split('\n').map(raw => raw.replace(/\[[^\]]*\]/g, ' ').trim())
        .filter(line => /[A-Za-zÀ-ÿ]{2,}/.test(line) && !LABEL.test(line) && !/^[eBGDAE]\s*\|/i.test(line) &&
            !line.split(/\s+/).every(token => CHORD.test(token) || /^[|():/\d.xX-]+$/.test(token)))
        .join(' ');
}

module.exports = { analyzeChordContent, extractChordContent, extractWordpressChordContent, elementText, extractLyricText };
