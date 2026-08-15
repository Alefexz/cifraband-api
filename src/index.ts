// functions/src/index.ts

import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import axios from "axios";
import * as cheerio from "cheerio";

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

const ENGINE_VERSION = 3;

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ======================================================
// CONFIGURAÇÕES
// ======================================================

const REQUEST_TIMEOUT = 4000;
const APPLE_TIMEOUT = 2000;
const WEB_SEARCH_TIMEOUT = 5000;

const CHUNK_SIZE = 3;

const KNOWN_ALIASES: Record<string, string> = {
  "fhop-music": "florianopolis-house-of-prayer",
  "fhop": "florianopolis-house-of-prayer",
  "nadson-o-ferinha": "nadson",
};

// ======================================================
// TIPOS INTERNOS
// ======================================================

interface AppleMetadata {
  imageUrl: string | null;
  cleanArtist: string;
  cleanTrack: string;
}

interface ScrapedCandidate {
  title: string;
  artist: string;
  imageUrl: string;
  originalKey: string | null;
  shapeKey: string | null;
  capo: string;
  content: string;
  url: string;

  // Somente interno. NÃO vai para o Flutter.
  titleScore: number;
  artistScore: number;
  contentScore: number;
  confidence: number;
}

// ======================================================
// NORMALIZAÇÃO
// ======================================================

function normalizeString(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " e ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSlug(value: string): string {
  return normalizeString(value)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Remove somente tags comerciais/de gravação.
 *
 * IMPORTANTE:
 * Não remove palavras como "music".
 * Não remove qualquer conteúdo entre parênteses.
 */
function cleanCommercialTags(text: string): string {
  let result = text.trim();

  result = result
    .replace(
      /\s*[\(\[]\s*(ao vivo|aovivo|live|official live|live session)\s*[\)\]]/gi,
      ""
    )
    .replace(
      /\s*[\(\[]\s*(single|acoustic|acustico|acústico)\s*[\)\]]/gi,
      ""
    )
    .replace(/\s*-\s*(ao vivo|aovivo|live)\s*$/gi, "")
    .replace(/\s*-\s*(single|acoustic|acustico|acústico)\s*$/gi, "")
    .trim();

  return result;
}

/**
 * Para comparação.
 * Mantém subtítulos importantes como:
 *
 * Coração Partido (Corazón Partío)
 *
 * mas ignora:
 *
 * (Ao Vivo)
 */
function normalizeForMatch(text: string): string {
  return normalizeString(cleanCommercialTags(text))
    .replace(/\b(ao vivo|aovivo|live|official|video|vídeo)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ======================================================
// ARTISTAS
// ======================================================

function splitArtistParts(artist: string): string[] {
  const parts = artist
    .split(/&|,|\bfeat\.?\b|\bft\.?\b|\bpart\.?\b|\be\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

  return [...new Set(parts)];
}

function getArtistTerms(artist: string): string[] {
  const terms = new Set<string>();

  const parts = splitArtistParts(artist);

  for (const part of parts) {
    const normalized = normalizeForMatch(part);

    if (normalized.length >= 3) {
      terms.add(normalized);
    }

    const slug = toSlug(part);

    if (KNOWN_ALIASES[slug]) {
      terms.add(normalizeForMatch(KNOWN_ALIASES[slug]));
    }
  }

  const whole = normalizeForMatch(artist);

  if (whole.length >= 3) {
    terms.add(whole);
  }

  return [...terms];
}

// ======================================================
// SIMILARIDADE DO TÍTULO
// ======================================================

function calculateTitleSimilarity(
  requestedTrack: string,
  pageTitle: string
): number {
  const requested = normalizeForMatch(requestedTrack);
  const candidate = normalizeForMatch(pageTitle);

  if (!requested || !candidate) {
    return 0;
  }

  // Correspondência exata
  if (requested === candidate) {
    return 1;
  }

  // A página contém exatamente o título pedido
  if (candidate.includes(requested)) {
    return 1;
  }

  // O pedido contém o título da página
  if (requested.includes(candidate) && candidate.length >= 5) {
    return 0.95;
  }

  const words = requested
    .split(" ")
    .filter((word) => word.length >= 2);

  if (words.length === 0) {
    return 0;
  }

  const candidateWords = new Set(
    candidate
      .split(" ")
      .filter((word) => word.length >= 2)
  );

  let matches = 0;

  for (const word of words) {
    if (candidateWords.has(word)) {
      matches++;
    }
  }

  return matches / words.length;
}

// ======================================================
// SIMILARIDADE DO ARTISTA
// ======================================================

function calculateArtistSimilarity(
  requestedArtist: string,
  pageArtistText: string,
  pageTitle: string,
  url: string
): number {
  const terms = getArtistTerms(requestedArtist);

  if (terms.length === 0) {
    return 0;
  }

  const metadata = normalizeForMatch(
    `${pageArtistText} ${pageTitle} ${url}`
  );

  let bestScore = 0;

  for (const term of terms) {
    if (!term) {
      continue;
    }

    if (metadata.includes(term)) {
      bestScore = Math.max(bestScore, 1);
      continue;
    }

    const termWords = term
      .split(" ")
      .filter((word) => word.length >= 3);

    if (termWords.length === 0) {
      continue;
    }

    const matches = termWords.filter((word) =>
      metadata.includes(word)
    ).length;

    const partial = matches / termWords.length;

    bestScore = Math.max(bestScore, partial);
  }

  return bestScore;
}

// ======================================================
// CONTEÚDO
// ======================================================

function calculateContentScore(
  content: string,
  visibleText: string
): number {
  if (!content || content.trim().length < 80) {
    return 0;
  }

  const chordMatches =
    content.match(
      /\b[A-G](?:#|b)?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-G](?:#|b)?)?\b/g
    ) || [];

  const uniqueChords = new Set(chordMatches);

  const hasKey =
    /(?:tom|tono|key)\s*[:\-]?\s*[A-G](?:#|b)?(?:m|maj|min)?\b/i.test(
      visibleText
    );

  let score = 0.5;

  if (content.length >= 300) {
    score += 0.15;
  }

  if (uniqueChords.size >= 2) {
    score += 0.15;
  }

  if (uniqueChords.size >= 4) {
    score += 0.1;
  }

  if (hasKey) {
    score += 0.1;
  }

  return Math.min(score, 1);
}

// ======================================================
// TOM
// ======================================================

function normalizeKey(key: string): string {
  const value = key.trim();

  if (!value) {
    return "";
  }

  return (
    value.charAt(0).toUpperCase() +
    value.slice(1).toLowerCase()
  );
}

function extractOriginalKey(text: string): string | null {
  const match = text.match(
    /(?:tom|tono|key)\s*[:\-]?\s*([A-G](?:#|b)?(?:m|maj|min)?)(?:\b|\s|\()/i
  );

  if (!match?.[1]) {
    return null;
  }

  return normalizeKey(match[1]);
}

// ======================================================
// CAPO
// ======================================================

function extractCapo(text: string): number | null {
  const match = text.match(
    /(?:capotraste|capo)\s*(?::|na|no|de)?\s*(\d{1,2})/i
  );

  if (!match?.[1]) {
    return null;
  }

  const value = Number(match[1]);

  if (!Number.isFinite(value) || value < 1 || value > 24) {
    return null;
  }

  return value;
}

// ======================================================
// FORMA DO ACORDE
// ======================================================

function extractShapeKey(text: string): string | null {
  const match = text.match(
    /forma(?:\s+dos\s+acordes|\s+de)?\s+(?:no\s+tom\s+de\s+)?([A-G](?:#|b)?(?:m|maj|min)?)/i
  );

  if (!match?.[1]) {
    return null;
  }

  return normalizeKey(match[1]);
}

// ======================================================
// INFERÊNCIA SEGURA DA FORMA PELO CAPO
// ======================================================

const CHROMATIC_SHARP = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

const FLAT_TO_SHARP: Record<string, string> = {
  Db: "C#",
  Eb: "D#",
  Gb: "F#",
  Ab: "G#",
  Bb: "A#",
};

function inferShapeFromCapo(
  originalKey: string | null,
  capo: number | null
): string | null {
  if (!originalKey || !capo) {
    return null;
  }

  const isMinor = originalKey.toLowerCase().endsWith("m");

  const base = isMinor
    ? originalKey.slice(0, -1)
    : originalKey;

  const normalizedBase =
    FLAT_TO_SHARP[base] || base;

  const index = CHROMATIC_SHARP.indexOf(normalizedBase);

  if (index < 0) {
    return null;
  }

  const shapeIndex =
    (index - capo + 12 * 10) % 12;

  return (
    CHROMATIC_SHARP[shapeIndex] +
    (isMinor ? "m" : "")
  );
}

// ======================================================
// APPLE METADATA
// ======================================================

async function fetchAppleMetadata(
  artist: string,
  track: string
): Promise<AppleMetadata> {
  try {
    const query = encodeURIComponent(
      `${artist} ${track}`
    );

    const url =
      `https://itunes.apple.com/search?term=${query}` +
      `&entity=song&limit=5`;

    const response = await axios.get(url, {
      timeout: APPLE_TIMEOUT,
      headers: {
        "User-Agent": userAgent,
      },
    });

    const results = response.data?.results || [];

    if (results.length > 0) {
      const requestedArtist = normalizeForMatch(artist);
      const requestedTrack = normalizeForMatch(track);

      let bestResult: any = null;
      let bestScore = -1;

      for (const result of results) {
        const resultArtist =
          normalizeForMatch(result.artistName || "");

        const resultTrack =
          normalizeForMatch(result.trackName || "");

        const artistScore =
          calculateTitleSimilarity(
            requestedArtist,
            resultArtist
          );

        const trackScore =
          calculateTitleSimilarity(
            requestedTrack,
            resultTrack
          );

        const score =
          artistScore * 0.4 +
          trackScore * 0.6;

        if (score > bestScore) {
          bestScore = score;
          bestResult = result;
        }
      }

      if (bestResult) {
        return {
          imageUrl:
            bestResult.artworkUrl100
              ? bestResult.artworkUrl100.replace(
                  "100x100bb",
                  "300x300bb"
                )
              : null,

          cleanArtist:
            bestResult.artistName || artist,

          cleanTrack:
            bestResult.trackName || track,
        };
      }
    }
  } catch (_) {
    // Apple é enriquecimento.
    // Nunca deve impedir a busca da cifra.
  }

  return {
    imageUrl: null,
    cleanArtist: artist,
    cleanTrack: track,
  };
}

// ======================================================
// GERAÇÃO DE URLS
// ======================================================

function generateSmartUrls(
  cleanArtist: string,
  cleanTrack: string
): string[] {
  const baseArtist = toSlug(cleanArtist);

  const trackForSearch =
    cleanCommercialTags(cleanTrack);

  const trackSlug =
    toSlug(trackForSearch);

  const artistsToTest: string[] = [];

  const checkAndAdd = (slug: string) => {
    if (
      slug &&
      slug.length >= 2 &&
      !artistsToTest.includes(slug)
    ) {
      artistsToTest.push(slug);
    }
  };

  const parts = splitArtistParts(cleanArtist);

  // ====================================================
  // ALIASES
  // ====================================================

  for (const part of parts) {
    const slug = toSlug(part);

    if (KNOWN_ALIASES[slug]) {
      checkAndAdd(KNOWN_ALIASES[slug]);
    }
  }

  if (KNOWN_ALIASES[baseArtist]) {
    checkAndAdd(KNOWN_ALIASES[baseArtist]);
  }

  // ====================================================
  // ARTISTAS ORIGINAIS
  // ====================================================

  for (const part of parts) {
    checkAndAdd(toSlug(part));
  }

  checkAndAdd(baseArtist);

  // Primeira palavra somente como fallback
  const firstWord = cleanArtist.split(/\s+/)[0];

  if (firstWord.length >= 4) {
    checkAndAdd(toSlug(firstWord));
  }

  // ====================================================
  // COMBINAÇÕES
  // ====================================================

  if (parts.length >= 2) {
    checkAndAdd(
      toSlug(`${parts[0]} e ${parts[1]}`)
    );
  }

  const urls = new Set<string>();

  // ====================================================
  // PRIORIDADE 1
  // URL EXATA
  // ====================================================

  for (const artistSlug of artistsToTest) {
    urls.add(
      `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}/`
    );

    urls.add(
      `https://www.cifras.com.br/cifra/${artistSlug}/${trackSlug}`
    );
  }

  // ====================================================
  // PRIORIDADE 2
  // VARIAÇÕES DE PARTICIPAÇÃO
  // ====================================================

  if (parts.length > 1) {
    for (const artistSlug of artistsToTest) {
      for (const part of parts) {
        const partSlug = toSlug(part);

        urls.add(
          `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}-part-${partSlug}/`
        );

        urls.add(
          `https://www.cifras.com.br/cifra/${artistSlug}/${trackSlug}-part-${partSlug}`
        );
      }
    }
  }

  // ====================================================
  // PRIORIDADE 3
  // ALGUMAS VARIAÇÕES DE PART
  // ====================================================

  if (parts.length > 1) {
    for (const artistSlug of artistsToTest) {
      const partSlug = toSlug(parts[0]);

      urls.add(
        `https://www.cifraclub.com.br/${artistSlug}/${trackSlug}-part-${partSlug}/`
      );
    }
  }

  // ====================================================
  // NÃO GERAMOS MAIS "trackSlugShort"
  //
  // Isso evitava alguns casos, mas criava falsos positivos.
  // ====================================================

  return [...urls];
}

// ======================================================
// EXTRAÇÃO DA PÁGINA
// ======================================================

async function extractFromUrl(
  url: string,
  requestedArtist: string,
  requestedTrack: string,
  appleData: AppleMetadata
): Promise<ScrapedCandidate | null> {
  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (status) =>
        status >= 200 && status < 400,
    });

    const finalUrl =
      response.request?.res?.responseUrl || url;

    // ==================================================
    // LETRA = NÃO É CIFRA
    // ==================================================

    if (
      /\/letra(?:\/|$)/i.test(finalUrl)
    ) {
      console.log(
        `[REJECT] Página de letra: ${finalUrl}`
      );

      return null;
    }

    const $ = cheerio.load(response.data);

    const content =
      $("pre").first().text().trim();

    if (!content || content.length < 50) {
      return null;
    }

    // ==================================================
    // METADADOS
    // ==================================================

    const h1 =
      $("h1").first().text().trim();

    const h2 =
      $("h2").first().text().trim();

    const ogTitle =
      $('meta[property="og:title"]')
        .attr("content")
        ?.trim() || "";

    const htmlTitle =
      $("title").first().text().trim();

    const pageTitle =
      h1 ||
      ogTitle ||
      htmlTitle ||
      "";

    const pageArtist =
      h2 ||
      "";

    const visibleText =
      $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim();

    // ==================================================
    // VALIDAÇÃO DO TÍTULO
    // ==================================================

    const titleScore =
      Math.max(
        calculateTitleSimilarity(
          requestedTrack,
          pageTitle
        ),
        calculateTitleSimilarity(
          requestedTrack,
          htmlTitle
        )
      );

    // ==================================================
    // VALIDAÇÃO DO ARTISTA
    // ==================================================

    const artistScore =
      calculateArtistSimilarity(
        requestedArtist,
        pageArtist,
        `${pageTitle} ${htmlTitle}`,
        finalUrl
      );

    // ==================================================
    // VALIDAÇÃO DO CONTEÚDO
    // ==================================================

    const contentScore =
      calculateContentScore(
        content,
        visibleText
      );

    // ==================================================
    // TOM
    // ==================================================

    let originalKey=extractOriginalKey(visibleText);if(!originalKey){const firstChordMatch=content.match(/\b([A-G](?:#|b)?(?:m)?)\b/);if(firstChordMatch&&firstChordMatch[1]){originalKey=normalizeKey(firstChordMatch[1]);}}

    const capoNumber =
      extractCapo(visibleText);

    const explicitShape =
      extractShapeKey(visibleText);

    const inferredShape =
      inferShapeFromCapo(
        originalKey,
        capoNumber
      );

    const shapeKey =
      explicitShape ||
      inferredShape ||
      originalKey ||
      null;

    const capo =
      capoNumber
        ? `${capoNumber}ª casa`
        : "";

    // ==================================================
    // CONFIANÇA
    // ==================================================

    const confidence =
      titleScore * 0.50 +
      artistScore * 0.35 +
      contentScore * 0.15;

    console.log(
      `[Candidate] ` +
      `Título: ${(titleScore * 100).toFixed(0)} | ` +
      `Artista: ${(artistScore * 100).toFixed(0)} | ` +
      `Conteúdo: ${(contentScore * 100).toFixed(0)} | ` +
      `Confiança: ${(confidence * 100).toFixed(0)} | ` +
      `${finalUrl}`
    );

    // ==================================================
    // GUILHOTINA REAL
    //
    // Não é "score 95".
    // São condições objetivas.
    // ==================================================

    const strongTitle =
      titleScore >= 0.85;

    const strongArtist =
      artistScore >= 0.60;

    const realCifra =
      contentScore >= 0.60;

    if (
      !strongTitle ||
      !strongArtist ||
      !realCifra
    ) {
      console.log(
        `[REJECT] Candidato não suficientemente confiável`
      );

      return null;
    }

    // ==================================================
    // RESULTADO
    // ==================================================

    const requestedDisplayArtist =
      cleanCommercialTags(requestedArtist);

    const requestedDisplayTrack =
      cleanCommercialTags(requestedTrack);

    const appleArtistIsReliable =
      calculateTitleSimilarity(
        requestedDisplayArtist,
        appleData.cleanArtist
      ) >= 0.70;

    const appleTrackIsReliable =
      calculateTitleSimilarity(
        requestedDisplayTrack,
        appleData.cleanTrack
      ) >= 0.70;

    return {
      title:
        appleTrackIsReliable
          ? appleData.cleanTrack
          : requestedDisplayTrack,

      artist:
        appleArtistIsReliable
          ? appleData.cleanArtist
          : requestedDisplayArtist,

      imageUrl:
        appleData.imageUrl || "",

      originalKey,

      shapeKey,

      capo,

      content,

      url: finalUrl,

      titleScore,

      artistScore,

      contentScore,

      confidence,
    };
  } catch (error: any) {
    return null;
  }
}

// ======================================================
// BUSCA WEB
// ======================================================

async function getWebSearchLinks(
  artist: string,
  track: string
): Promise<string[]> {
  const links = new Set<string>();

  const cleanArtist =
    cleanCommercialTags(artist);

  const cleanTrack =
    cleanCommercialTags(track);

  const queries = [
    `"${cleanTrack}" "${cleanArtist}" cifra`,
    `"${cleanTrack}" ${cleanArtist} cifra`,
    `${cleanTrack} ${cleanArtist} site:cifraclub.com.br`,
  ];

  // ====================================================
  // DUCKDUCKGO
  // ====================================================

  for (const searchQuery of queries) {
    try {
      const response = await axios.post(
        "https://lite.duckduckgo.com/lite/",
        `q=${encodeURIComponent(searchQuery)}`,
        {
          headers: {
            "User-Agent": userAgent,
            "Content-Type":
              "application/x-www-form-urlencoded",
          },
          timeout: WEB_SEARCH_TIMEOUT,
        }
      );

      const $ = cheerio.load(
        response.data
      );

      $("a").each((_, element) => {
        let href =
          $(element).attr("href");

        if (!href) {
          return;
        }

        if (
          !href.includes(
            "cifraclub.com.br"
          ) &&
          !href.includes(
            "cifras.com.br"
          )
        ) {
          return;
        }

        if (
          /\/letra(?:\/|$)/i.test(href)
        ) {
          return;
        }

        if (href.includes("uddg=")) {
          const match =
            href.match(/uddg=([^&]+)/);

          if (match?.[1]) {
            href =
              decodeURIComponent(
                match[1]
              );
          }
        }

        links.add(href);
      });
    } catch (_) {
      // continua
    }

    if (links.size >= 10) {
      break;
    }
  }

  // ====================================================
  // YAHOO COMO SEGUNDO MOTOR
  // ====================================================

  if (links.size < 3) {
    const searchQuery =
      `"${cleanTrack}" "${cleanArtist}" cifra`;

    try {
      const response =
        await axios.get(
          `https://br.search.yahoo.com/search?p=${encodeURIComponent(
            searchQuery
          )}`,
          {
            headers: {
              "User-Agent": userAgent,
            },
            timeout:
              WEB_SEARCH_TIMEOUT,
          }
        );

      const $ = cheerio.load(
        response.data
      );

      $("a").each((_, element) => {
        let href =
          $(element).attr("href");

        if (!href) {
          return;
        }

        if (
          !href.includes(
            "cifraclub.com.br"
          ) &&
          !href.includes(
            "cifras.com.br"
          )
        ) {
          return;
        }

        if (
          /\/letra(?:\/|$)/i.test(href)
        ) {
          return;
        }

        if (href.includes("RU=")) {
          const match =
            href.match(
              /RU=([^/]+)\/RS=/
            );

          if (match?.[1]) {
            href =
              decodeURIComponent(
                match[1]
              );
          }
        }

        links.add(href);
      });
    } catch (_) {
      // continua
    }
  }

  return [...links];
}

// ======================================================
// RESULTADO PÚBLICO
// ======================================================

function toPublicResult(
  candidate: ScrapedCandidate
) {
  return {
    title: candidate.title,
    artist: candidate.artist,
    imageUrl: candidate.imageUrl,
    originalKey: candidate.originalKey || "",
    shapeKey: candidate.shapeKey || "",
    capo: candidate.capo || "",
    content: candidate.content,
    url: candidate.url,
  };
}

// ======================================================
// VALIDA CACHE
// ======================================================

function isCacheValid(
  data: any,
  requestedArtist: string,
  requestedTrack: string
): boolean {
  if (!data) {
    return false;
  }

  if (
    data.engineVersion !== ENGINE_VERSION
  ) {
    return false;
  }

  if (
    typeof data.content !== "string" ||
    data.content.length < 50
  ) {
    return false;
  }

  const titleScore =
    calculateTitleSimilarity(
      requestedTrack,
      data.title || ""
    );

  const artistScore =
    calculateArtistSimilarity(
      requestedArtist,
      data.artist || "",
      data.title || "",
      data.url || ""
    );

  return (
    titleScore >= 0.85 &&
    artistScore >= 0.60
  );
}

// ======================================================
// SALVAR CACHE
// ======================================================

async function saveResult(
  docId: string,
  result: ScrapedCandidate
): Promise<void> {
  await db
    .collection("cifras_globais")
    .doc(docId)
    .set({
      ...toPublicResult(result),
      engineVersion: ENGINE_VERSION,
     createdAt:new Date()
    });
}

// ======================================================
// ALIAS SEGURO
// ======================================================

function getArtistSlugFromUrl(
  url: string
): string | null {
  try {
    const urlObj = new URL(url);

    const parts =
      urlObj.pathname
        .split("/")
        .filter(Boolean);

    if (
      urlObj.hostname.includes(
        "cifras.com.br"
      )
    ) {
      if (parts[0] === "cifra") {
        return parts[1] || null;
      }

      // páginas de instrumento:
      // /teclado/artista/musica
      if (
        parts.length >= 3 &&
        [
          "teclado",
          "violao",
          "guitarra",
          "ukulele",
          "cavaco",
          "viola",
        ].includes(parts[0])
      ) {
        return parts[1] || null;
      }

      return null;
    }

    return parts[0] || null;
  } catch (_) {
    return null;
  }
}

async function saveArtistAliasIfSafe(
  requestedArtist: string,
  candidate: ScrapedCandidate
): Promise<void> {
  const requestedSlug =
    toSlug(requestedArtist);

  const foundSlug =
    getArtistSlugFromUrl(candidate.url);

  if (
    !foundSlug ||
    foundSlug === requestedSlug
  ) {
    return;
  }

  if (
    candidate.titleScore < 0.95 ||
    candidate.artistScore < 0.90
  ) {
    return;
  }

  await db
    .collection("artist_aliases")
    .doc(`alias_${requestedSlug}`)
    .set({
      realSlug: foundSlug,
      source: new URL(candidate.url).hostname,
     updatedAt:new Date()
    });

  console.log(
    `[Alias] ${requestedSlug} -> ${foundSlug}`
  );
}

// ======================================================
// ORQUESTRADOR
// ======================================================

export const searchSong = onRequest(
  {
    timeoutSeconds: 60,
  },
  async (req, res) => {
    res.set(
      "Access-Control-Allow-Origin",
      "*"
    );

    if (req.method === "OPTIONS") {
      res.set(
        "Access-Control-Allow-Methods",
        "GET"
      );

      res.status(204).send("");
      return;
    }

    const rawArtist =
      typeof req.query.artist === "string"
        ? req.query.artist
        : "";

    const rawTrack =
      typeof req.query.track === "string"
        ? req.query.track
        : "";

    if (!rawArtist || !rawTrack) {
      res.status(400).json({
        error:
          "Parâmetros obrigatórios ausentes.",
      });
      return;
    }

    try {
      console.log(
        `\n======================================================`
      );

      console.log(
        `[Nova Requisição] Buscando: ${rawArtist} - ${rawTrack}`
      );

      // ==================================================
      // IDENTIDADE DO PEDIDO
      //
      // NÃO usamos Apple para decidir isso.
      // ==================================================

      const searchArtist =
        cleanCommercialTags(rawArtist);

      const searchTrack =
        cleanCommercialTags(rawTrack);

      const artistSlug =
        toSlug(searchArtist);

      const trackSlug =
        toSlug(searchTrack);

      const docId =
        `${artistSlug}-${trackSlug}`;

      // ==================================================
      // CACHE
      //
      // Verificamos ANTES da Apple.
      // ==================================================

      const cacheDoc =
        await db
          .collection("cifras_globais")
          .doc(docId)
          .get();

      if (cacheDoc.exists) {
        const cached =
          cacheDoc.data();

        if (
          isCacheValid(
            cached,
            searchArtist,
            searchTrack
          )
        ) {
          console.log(
            `[Motor V2] HIT! Cache confiável.`
          );

          res.status(200).json(
            cached
          );

          return;
        }

        console.log(
          `[Cache] Resultado antigo/incompatível. Reprocessando.`
        );
      }

      // ==================================================
      // APPLE
      //
      // Apenas enriquecimento.
      // ==================================================

      const appleData =
        await fetchAppleMetadata(
          searchArtist,
          searchTrack
        );

      // ==================================================
      // ALIAS SALVO
      // ==================================================

      const aliasDoc =
        await db
          .collection("artist_aliases")
          .doc(`alias_${artistSlug}`)
          .get();

      if (aliasDoc.exists) {
        const alias =
          aliasDoc.data()?.realSlug;

        const source =
          aliasDoc.data()?.source ||
          "cifraclub.com.br";

        if (alias) {
          const baseUrl =
            source.includes("cifras")
              ? "https://www.cifras.com.br/cifra"
              : "https://www.cifraclub.com.br";

          const aliasUrl =
            `${baseUrl}/${alias}/${trackSlug}/`;

          console.log(
            `[Alias] Testando: ${aliasUrl}`
          );

          const aliasResult =
            await extractFromUrl(
              aliasUrl,
              searchArtist,
              searchTrack,
              appleData
            );

          if (aliasResult) {
            console.log(
              `[ACCEPT] Encontrada pelo alias.`
            );

            await saveResult(
              docId,
              aliasResult
            );

            res.status(200).json(
              toPublicResult(
                aliasResult
              )
            );

            return;
          }
        }
      }

      // ==================================================
      // SMART ENGINE
      // ==================================================

      const testUrls =
        generateSmartUrls(
          searchArtist,
          searchTrack
        );

      console.log(
        `[Smart Engine] Disparando ${testUrls.length} URLs...`
      );

      let bestCandidate:
        ScrapedCandidate | null = null;

      // ==================================================
      // LOTES
      // ==================================================

      for (
        let i = 0;
        i < testUrls.length;
        i += CHUNK_SIZE
      ) {
        const chunk =
          testUrls.slice(
            i,
            i + CHUNK_SIZE
          );

        const results =
          await Promise.all(
            chunk.map((url) =>
              extractFromUrl(
                url,
                searchArtist,
                searchTrack,
                appleData
              )
            )
          );

        const validResults =
          results.filter(
            (
              result
            ): result is ScrapedCandidate =>
              result !== null
          );

        for (const result of validResults) {
          if (
            !bestCandidate ||
            result.confidence >
              bestCandidate.confidence
          ) {
            bestCandidate = result;
          }
        }

        // ==================================================
        // FAST PATH
        //
        // Se encontramos:
        // título praticamente exato
        // + artista confirmado
        // não precisamos continuar.
        // ==================================================

        if (
          bestCandidate &&
          bestCandidate.titleScore >=
            0.95 &&
          bestCandidate.artistScore >=
            0.90 &&
          bestCandidate.contentScore >=
            0.60
        ) {
          console.log(
            `[FAST PATH] Candidato altamente confiável encontrado.`
          );

          break;
        }
      }

      // ==================================================
      // SE ENCONTROU
      // ==================================================

      if (bestCandidate) {
        console.log(
          `[ACCEPT] ` +
          `${bestCandidate.title} | ` +
          `Tom: ${bestCandidate.originalKey} | ` +
          `Forma: ${bestCandidate.shapeKey} | ` +
          `Capo: ${bestCandidate.capo}`
        );

        await saveArtistAliasIfSafe(
          searchArtist,
          bestCandidate
        );

        await saveResult(
          docId,
          bestCandidate
        );

        res.status(200).json(
          toPublicResult(
            bestCandidate
          )
        );

        return;
      }

      // ==================================================
      // WEB SEARCH
      // ==================================================

      const links =
        await getWebSearchLinks(
          searchArtist,
          searchTrack
        );

      console.log(
        `[WebSearch] Testando ${links.length} links...`
      );

      let bestWebCandidate:
        ScrapedCandidate | null = null;

      for (
        let i = 0;
        i < links.length;
        i += CHUNK_SIZE
      ) {
        const chunk =
          links.slice(
            i,
            i + CHUNK_SIZE
          );

        const results =
          await Promise.all(
            chunk.map((url) =>
              extractFromUrl(
                url,
                searchArtist,
                searchTrack,
                appleData
              )
            )
          );

        const validResults =
          results.filter(
            (
              result
            ): result is ScrapedCandidate =>
              result !== null
          );

        for (const result of validResults) {
          if (
            !bestWebCandidate ||
            result.confidence >
              bestWebCandidate.confidence
          ) {
            bestWebCandidate = result;
          }
        }

        if (
          bestWebCandidate &&
          bestWebCandidate.titleScore >=
            0.95 &&
          bestWebCandidate.artistScore >=
            0.90
        ) {
          break;
        }
      }

      if (bestWebCandidate) {
        console.log(
          `[ACCEPT WEB] ${bestWebCandidate.url}`
        );

        await saveArtistAliasIfSafe(
          searchArtist,
          bestWebCandidate
        );

        await saveResult(
          docId,
          bestWebCandidate
        );

        res.status(200).json(
          toPublicResult(
            bestWebCandidate
          )
        );

        return;
      }

      // ==================================================
      // NÃO ENCONTROU
      // ==================================================

      throw new Error(
        "Música não encontrada em nenhum de nossos catálogos."
      );
    } catch (error: any) {
      console.error(
        `[API Error]`,
        error?.message || error
      );

      res.status(404).json({
        error:
          error?.message ||
          "Música não encontrada.",
      });
    }
  }
);