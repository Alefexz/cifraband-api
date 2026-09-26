// Catalogs sometimes truncate the parenthesized track list of a named medley.
// Keep the medley's identity, never reduce an ordinary A / B medley to A.
function catalogTitle(value) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    if (/^medley\s*[-:–—]?\s*[^([]{4,}\s*\(/i.test(title)) {
        return title.slice(0, title.indexOf('(')).trim();
    }
    return title;
}
module.exports = {catalogTitle};
