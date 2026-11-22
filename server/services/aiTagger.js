import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';
import { config } from '../config/env.js';
import { mediaDB } from '../db/database.js';

let aiClient = null;
let cachedApiKey = null;

export function resetAIClient() {
  aiClient = null;
  cachedApiKey = null;
}

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY || config.geminiApiKey;
  if (!apiKey) return null;
  if (!aiClient || cachedApiKey !== apiKey) {
    try {
      aiClient = new GoogleGenAI({ apiKey });
      cachedApiKey = apiKey;
    } catch (err) {
      console.warn('[AI] Failed to initialize GoogleGenAI client:', err.message);
      aiClient = null;
      cachedApiKey = null;
    }
  }
  return aiClient;
}

/**
 * Heuristic parser from filename (and optional parent torrent/folder context)
 */
export function heuristicParseFilename(filename, contextHint = '') {
  const base = filename.replace(/\.[^/.]+$/, ''); // remove extension
  let clean = base.replace(/[\._]/g, ' ');
  const combinedText = `${filename} ${clean} ${contextHint} ${contextHint.replace(/[\._]/g, ' ')}`;

  // Detect adult content tags, studios, & keywords (err on side of caution)
  const ADULT_WORD_PATTERNS = [
    'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'facefuck', 'anal', 'assaholic',
    'porn', 'porno', 'xxx', 'nsfw', 'creampie', 'creampies', 'blowjob', 'blowjobs',
    'handjob', 'footjob', 'rimjob', 'deepthroat', 'pussy', 'pussies', 'cock', 'cocks',
    'dick', 'dicks', 'dickdrainer', 'tits', 'boobs', 'slut', 'sluts', 'slutty',
    'whore', 'whores', 'milf', 'milfs', 'hentai', 'threesome', 'foursome', 'gangbang',
    'orgy', 'dildo', 'masturbat', 'masturbate', 'masturbation', 'cum', 'cumshot', 'squirt',
    'bdsm', 'femdom', 'bondage', 'fetish', 'erotic', 'hardcore', 'stepmom', 'stepsis',
    'stepsister', 'stepson', 'stepdad', 'stepbrother', 'lesbian', 'lesbians',
    'brazzers', 'bangbros', 'naughtyamerica', 'realitykings', 'mofos', 'evilangel',
    'blacked', 'blackedraw', 'tushy', 'tushyraw', 'vixen', 'deeper', 'slayed',
    'sextury', '21sextury', 'dorcel', 'puretaboo', 'swallowed', 'realwifestories',
    'fakehostel', 'fakehub', 'diabolic', 'analcollege', 'woodman', 'teenslikeitbig',
    'teamskeet', 'digitalplayground', 'wickedpictures', 'onlyfans', 'manyvids', 'chaturbate',
    'siterip', 'ahasss', 'symmetrical'
  ];

  const ADULT_PHRASE_PATTERNS = [
    '21 sextury', 'pure pleasures', 'pure taboo', 'naughty america', 'reality kings',
    'evil angel', 'team skeet', 'new sensations', 'sweet sinner', 'marc dorcel',
    'swap fuck', 'daughter swap', 'wife swap', 'horny housewives', 'sex addicts',
    'avi love', 'harley jade', 'pigtail facefuck', 'sluts love', 'split scenes', 'wicked pictures'
  ];

  const sePattern = /\bS(\d{1,2})[\s-]*E(\d{1,3})\b/i;
  const seasonEpWordsPattern = /\bSeason[\s-]*(\d{1,2})[\s-]*(?:Episode|Ep)[\s-]*(\d{1,3})\b/i;
  const xFormatPattern = /\b(\d{1,2})x(\d{1,3})\b/i;
  const hasEpisodeCode =
    sePattern.test(combinedText) ||
    seasonEpWordsPattern.test(combinedText) ||
    xFormatPattern.test(combinedText);

  const wordRegex = new RegExp(`\\b(${ADULT_WORD_PATTERNS.join('|')})\\b`, 'i');
  const phraseRegex = new RegExp(`(${ADULT_PHRASE_PATTERNS.join('|')}|fuck|porn|xxx|creampie|blowjob|dickdrainer|puretaboo|swallowed|realwifestories|fakehostel|diabolic|ahasss|symmetrical|assaholic|sextury|brazzers|bangbros|blacked|tushy)`, 'i');
  const scenePattern = /\bscene\s+\d+\b/i.test(combinedText) && /\b(1080p|720p|2160p|4k)\b/i.test(combinedText) && !hasEpisodeCode;
  const genericPrivatePattern = /^(0*\d{1,4}|testvid\d*|vid_?\d+|clip_?\d+|private_?.*)$/i.test(base.trim());

  const isAdult = wordRegex.test(combinedText) || phraseRegex.test(combinedText) || scenePattern || genericPrivatePattern;

  // Detect Season & Episode (e.g. S01E02, S05 E05, S05-E05, Season 5 Episode 5, or 1x02)
  const seMatch = clean.match(sePattern) || clean.match(seasonEpWordsPattern) || clean.match(xFormatPattern);
  let season = null;
  let episode = null;
  let type = 'movie';

  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
    type = 'series';
  }

  // Detect Resolution
  const resMatch = clean.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  const resolution = resMatch ? resMatch[1].toLowerCase() : '1080p';

  // Detect Codec
  const codecMatch = clean.match(/\b(x265|hevc|h265|x264|h264|av1)\b/i);
  const video_codec = codecMatch ? codecMatch[1].toLowerCase() : 'x264';

  // Smarter Release-Year Detection:
  // Inspect only the portion before SxxExx or technical release tags so numbers inside titles
  // like "1917 (2019)", "2001 A Space Odyssey (1968)", or "Blade Runner 2049 (2017)" never truncate the title.
  const maxPlausibleYear = Math.max(2028, new Date().getFullYear() + 2);
  const techTagBoundaryRegex =
    /\b(2160p|4k|1080p|720p|480p|360p|WEBRip|BluRay|BDRip|BRRip|HDRip|DVDRip|AMZN|NF|ATVP|DSNP|HMAX|WEB-DL|WEBDL|HDTV|REMUX|x265|hevc|h265|x264|h264|av1)\b/i;

  const seBoundaryIdx = seMatch ? (seMatch.index ?? clean.indexOf(seMatch[0])) : -1;
  const techMatch = clean.match(techTagBoundaryRegex);
  const techBoundaryIdx = techMatch ? (techMatch.index ?? clean.indexOf(techMatch[0])) : -1;

  let yearSearchLimit = clean.length;
  if (seBoundaryIdx > 0) yearSearchLimit = Math.min(yearSearchLimit, seBoundaryIdx);
  if (techBoundaryIdx > 0) yearSearchLimit = Math.min(yearSearchLimit, techBoundaryIdx);

  const prefixForYear = clean.substring(0, yearSearchLimit);
  let year = null;
  let yearCutoffIdx = -1;

  // 1. Prefer explicit parenthesized/bracketed year e.g. "(2019)" or "[2024]" after the first word
  const parenYearMatches = [...prefixForYear.matchAll(/[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/g)].filter(
    (m) => parseInt(m[1], 10) <= maxPlausibleYear && (m.index ?? 0) > 0
  );
  if (parenYearMatches.length > 0) {
    const chosen = parenYearMatches[parenYearMatches.length - 1];
    year = parseInt(chosen[1], 10);
    yearCutoffIdx = chosen.index;
  } else {
    // 2. Otherwise pick the last plausible 4-digit release year at index > 0 (so leading numeric titles like "1917" stay intact)
    const bareYearMatches = [...prefixForYear.matchAll(/\b(19\d\d|20\d\d)\b/g)].filter(
      (m) => parseInt(m[1], 10) <= maxPlausibleYear && (m.index ?? 0) > 0
    );
    if (bareYearMatches.length > 0) {
      const chosen = bareYearMatches[bareYearMatches.length - 1];
      year = parseInt(chosen[1], 10);
      yearCutoffIdx = chosen.index;
    }
  }

  // Extract clean title by taking words before year or season
  let title = clean;
  let episodeTitle = null;
  if (seMatch) {
    const idx = seBoundaryIdx;
    if (idx > 0) {
      // If a trailing release year sits immediately before SxxExx (e.g. "Dark Matter 2024 S01E01"), strip it cleanly
      const rawSeriesPrefix = clean.substring(0, idx);
      if (yearCutoffIdx > 0 && rawSeriesPrefix.substring(yearCutoffIdx).replace(/[\s\(\)\[\]\-–—:|0-9]/g, '').length === 0) {
        title = rawSeriesPrefix.substring(0, yearCutoffIdx);
      } else {
        title = rawSeriesPrefix;
      }
    }

    // Extract whatever comes after the SxxExx tag (e.g. Sayonara or Down and Out)
    const afterSe = idx >= 0 ? clean.substring(idx + seMatch[0].length).trim() : '';
    const cleanAfter = afterSe
      .replace(/[\(\[][^)\]]*\b(2160p|4k|1080p|720p|480p|360p|WEBRip|BluRay|AMZN|NF|WEB-DL|WEB|AAC|DD5|10bit|DDP5|x265|x264|hevc|h264|av1|Repack|RP)\b.*$/i, '')
      .replace(/\b(2160p|4k|1080p|720p|480p|360p|WEBRip|BluRay|AMZN|NF|WEB-DL|WEB|AAC|DD5|10bit|DDP5|x265|x264|hevc|h264|av1|MiNX|GalaxyRG|MeGusta|TGx|PSA|ELiTE|Rapta|NeoNoir|Vyndros)\b.*$/i, '')
      .replace(/^[\s\-–—:|]+/, '')
      .replace(/[\s\-–—:|(\[]+$/, '')
      .trim();
    if (cleanAfter.length > 0) {
      episodeTitle = cleanAfter;
    }
  } else if (yearCutoffIdx > 0) {
    title = clean.substring(0, yearCutoffIdx);
  } else if (techBoundaryIdx > 0) {
    title = clean.substring(0, techBoundaryIdx);
  }

  // Clean trailing release groups, tags, and dangling separators
  title = title
    .replace(/[\(\[][^)\]]*\b(2160p|4k|1080p|720p|480p|360p|WEBRip|BluRay|AMZN|NF|WEB-DL|WEB|AAC|DD5|10bit|DDP5|x265|x264|hevc|h264|av1|Repack|RP)\b.*$/i, '')
    .replace(/\b(WEBRip|BluRay|AMZN|NF|WEB-DL|AAC|DD5|10bit|MiNX|GalaxyRG|MeGusta|TGx|PSA|ELiTE|Rapta)\b.*$/i, '')
    .replace(/^[\s\-–—:|]+/, '')
    .replace(/[\s\-–—:|(\[]+$/, '')
    .trim();

  let formattedTitle = title || base;
  if (type === 'series') {
    const epLabel = season !== null && episode !== null ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';
    if (epLabel) {
      formattedTitle = episodeTitle ? `${title} ${epLabel}: ${episodeTitle}` : `${title} ${epLabel}`;
    }
  }

  return {
    id: crypto.createHash('md5').update(filename).digest('hex'),
    filename,
    title: formattedTitle,
    type,
    series_name: type === 'series' ? title : null,
    season,
    episode,
    episode_title: episodeTitle,
    year,
    resolution,
    video_codec,
    is_adult: isAdult,
  };
}

export const MEDIA_METADATA_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    type: { type: 'string', enum: ['movie', 'series', 'documentary', 'others'] },
    series_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    season: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    episode: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    episode_title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    year: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    plot: { type: 'string' },
    series_plot: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    genres: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    poster_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    backdrop_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    is_adult: { type: 'boolean' },
  },
  required: ['title', 'type', 'plot', 'genres', 'tags', 'is_adult'],
};

/**
 * Checks whether a synopsis string is missing or one of Kodimi's generic placeholder fallbacks.
 */
export function isPlaceholderOrGenericPlot(plot) {
  if (!plot || typeof plot !== 'string') return true;
  const t = plot.trim();
  if (t.length < 24) return true;
  if (/^(Enjoy|Watch)\s+.+\s+(streaming(?:\s+in\s+\S+)?|in\s+high\s+definition)\s+on\s+(your\s+personal\s+)?Kodimi/i.test(t)) {
    return true;
  }
  if (/^(No synopsis available|Stream seamlessly on Kodimi|Browse all seasons and episodes|Stream this episode in full high definition)/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * Extracts and parses a JSON object from model output, tolerating markdown code fences
 * or grounded search preamble/citation text around the JSON payload.
 */
export function extractJsonObject(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty AI response text');
  }

  const trimmed = rawText.trim();
  const strippedFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(strippedFence);
  } catch (_) {}

  // Scan for the outermost balanced {...} JSON block (string-escape aware)
  const firstBrace = strippedFence.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('No JSON object found in AI response');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < strippedFence.length; i++) {
    const ch = strippedFence[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = strippedFence.slice(firstBrace, i + 1);
        return JSON.parse(candidate);
      }
    }
  }

  throw new Error('Unterminated JSON object in AI response');
}

function isRetryableGeminiError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status || err?.code;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /\b(429|500|502|503|504|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|fetch failed)\b/i.test(msg);
}

function isUnsupportedStructuredGroundingError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status || err?.code;
  if (status === 400 || /\b400\b|INVALID_ARGUMENT/i.test(msg)) {
    return /tool|google_?search|response_?mime_?type|response_?format|schema|json/i.test(msg);
  }
  return false;
}

function extractInteractionText(interaction) {
  if (!interaction) return '';
  if (typeof interaction.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text;
  }
  if (Array.isArray(interaction.steps)) {
    for (let i = interaction.steps.length - 1; i >= 0; i--) {
      const step = interaction.steps[i];
      if (step?.type === 'model_output' && Array.isArray(step.content)) {
        const text = step.content
          .filter((c) => c?.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
        if (text.trim()) return text;
      }
    }
  }
  if (typeof interaction.text === 'string') return interaction.text;
  return '';
}

function choosePreferredSeriesName(candidate, existingCanonical) {
  if (!existingCanonical) return candidate;
  if (!candidate) return existingCanonical;
  // Prefer official mixed-case branding (e.g. "MobLand" over "Mobland") or punctuation/subtitles (e.g. "X-Men '97", "Special Ops: Lioness")
  const candHasCamel = /[a-z][A-Z]/.test(candidate);
  const existHasCamel = /[a-z][A-Z]/.test(existingCanonical);
  if (candHasCamel && !existHasCamel) return candidate;
  const candHasPunct = /[:'!?-]/.test(candidate);
  const existHasPunct = /[:'!?-]/.test(existingCanonical);
  if (candHasPunct && !existHasPunct) return candidate;
  return existingCanonical;
}

async function generateGroundedMetadataJson(client, prompt) {
  const maxAttempts = 3;
  let useStructuredSchema = true;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const interactionParams = {
        model: 'gemini-3.8-flash',
        input: prompt,
        tools: [{ type: 'google_search' }],
        generation_config: {
          thinking_level: 'low',
        },
        store: false,
      };

      if (useStructuredSchema) {
        interactionParams.response_format = {
          type: 'text',
          mime_type: 'application/json',
          schema: MEDIA_METADATA_JSON_SCHEMA,
        };
      }

      const interaction = await client.interactions.create(interactionParams);
      const rawText = extractInteractionText(interaction);
      return extractJsonObject(rawText);
    } catch (err) {
      lastError = err;
      if (useStructuredSchema && isUnsupportedStructuredGroundingError(err)) {
        useStructuredSchema = false;
        attempt--; // Retry immediately without structured schema constraint while keeping Google Search grounding
        continue;
      }
      if (attempt < maxAttempts && isRetryableGeminiError(err)) {
        const backoffMs = 1500 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Gemini metadata enrichment failed');
}

/**
 * Enriches media metadata using Google Gemini AI (Interactions API) with Google Search Grounding.
 * Falls back to heuristic parsing if API is unavailable.
 */
export async function enrichMediaMetadata(filename, fileSize = 0, contextHint = '', options = {}) {
  const matchHint = typeof options?.matchHint === 'string' ? options.matchHint.trim() : '';
  const categoryOverride = typeof options?.category === 'string' ? options.category.trim().toLowerCase() : '';
  const parsed = heuristicParseFilename(filename, contextHint);

  // If adult content, avoid sending to general safety filters and generate structured tags
  if (parsed.is_adult) {
    return {
      ...parsed,
      size_bytes: fileSize,
      plot: 'Private Media content.',
      series_plot: null,
      genres: ['Adult'],
      tags: ['Private', '18+'],
      poster_url: 'https://images.unsplash.com/photo-1518173946687-a4c8892bbd9f?w=600&auto=format&fit=crop&q=80',
      backdrop_url: 'https://images.unsplash.com/photo-1518173946687-a4c8892bbd9f?w=1200&auto=format&fit=crop&q=80',
    };
  }

  const client = getAIClient();
  if (!client) {
    // Generate fallback visuals
    return applyCategoryOverride(generateFallbackMetadata(parsed, fileSize), categoryOverride);
  }

  try {
    let existingSeries = null;
    if (!matchHint && parsed.type === 'series' && parsed.series_name && mediaDB.getSeriesInfo) {
      existingSeries = mediaDB.getSeriesInfo(parsed.series_name);
    }

    const existingSeriesNote =
      !matchHint && existingSeries?.year
        ? `\nCATALOG CONTEXT: This series is already indexed in the catalog as the ${existingSeries.year} show ("${existingSeries.series_name}"). Match the ${existingSeries.year} show version, cast, and episode guide.`
        : '';

    const userHintBlock = matchHint
      ? `\nAUTHORITATIVE USER MATCH HINT: "${matchHint}". You MUST prioritize this exact title/year/adaptation specified by the user over any ambiguous filename guesses.`
      : '';

    const prompt = `You are an authoritative movie and television metadata archivist for a personal streaming platform named Kodimi.
Analyze this video file name: "${filename}" ${contextHint ? `(from release: "${contextHint}")` : ''}.
Heuristic parse -> Detected Type: "${parsed.type}", Season: ${parsed.season ?? 'null'}, Episode: ${parsed.episode ?? 'null'}, Inferred Year: ${parsed.year ?? 'null'}, Inferred Series: "${parsed.series_name || ''}", Inferred Title: "${parsed.title || ''}", Inferred Episode Title: "${parsed.episode_title || ''}".${existingSeriesNote}${userHintBlock}

MANDATORY VERIFICATION & ACCURACY RULES:
1. USE GOOGLE SEARCH GROUNDING to verify the real-world movie, documentary, or TV show, exact release year, cast/characters, overarching series premise, and official Season/Episode guide before writing any synopsis. NEVER invent or hallucinate plot points, character names, or fake episode storylines.
2. If this is adult/pornographic/XXX/18+ explicit content, set "is_adult": true, "type": "movie", "series_name": null, "series_plot": null.
3. If this is a TV series episode (contains SxxExx / Season-Episode pattern, or user hint indicates a TV series):
   - Set "type": "series" (even for multi-episode docuseries, keep "type": "series" and include "Documentary" in "genres")
   - Set "series_name": Canonical official name of the TV show with official casing (e.g. "MobLand", "Slow Horses", "Dark Matter", "Succession")
   - Set "season": Season number (integer)
   - Set "episode": Episode number (integer)
   - Set "episode_title": Verified official title of Season {season}, Episode {episode} (or null if untitled)
   - Set "title": MUST be formatted as "{series_name} S{XX}E{XX}: {episode_title}" (or "{series_name} S{XX}E{XX}" if episode_title is null)
   - Set "year": Premiere year of this TV series adaptation (e.g. 2025 for Paramount+'s MobLand, 2024 for Apple TV+'s Dark Matter)
   - Set "series_plot": Verified 2-3 sentence overarching synopsis of the TV series as a whole
   - Set "plot": Verified 2-3 sentence synopsis of THIS SPECIFIC EPISODE (Season {season}, Episode {episode}). If this specific episode's official synopsis has not been published yet, write a concise factual 1-2 sentence description referencing verified Season {season} context without fabricating scenes.
4. If this is a standalone Documentary film (non-episodic documentary feature/special):
   - Set "type": "documentary"
   - Include "Documentary" in "genres" and "tags"
   - Set "series_name": null, "season": null, "episode": null, "episode_title": null, "series_plot": null
5. If this is a standalone Movie:
   - Set "type": "movie"
   - Set "series_name": null, "season": null, "episode": null, "episode_title": null, "series_plot": null
   - Set "title": Canonical official movie title (keep numbers that belong to the title, e.g. "1917", "Blade Runner 2049", "2001: A Space Odyssey")
   - Set "year": Verified theatrical/streaming release year of this exact film
   - Set "plot": Verified 2-3 sentence factual synopsis of this exact film (matching its real cast and release year).
6. If this is a non-film clip, social media video, YouTube talk, podcast, lecture, or miscellaneous video:
   - Set "type": "others"
   - Include "Others" in "tags"
7. DISAMBIGUATION RULE:
   Unless an explicit release year or user match hint specifies an older version, prefer the modern/recent well-known release (including 2024–2026 films and streaming series).

Return ONLY a strictly valid JSON object matching:
{
  "title": string,
  "type": "movie" | "series" | "documentary" | "others",
  "series_name": string | null,
  "season": integer | null,
  "episode": integer | null,
  "episode_title": string | null,
  "year": integer | null,
  "plot": string,
  "series_plot": string | null,
  "genres": string[],
  "tags": string[],
  "poster_url": string | null,
  "backdrop_url": string | null,
  "is_adult": boolean
}`;

    const aiData = await generateGroundedMetadataJson(client, prompt);

    // If filename has SxxExx and parsed.is_adult is false, never allow AI hallucination to mark it as adult
    const isAdultDetected = Boolean(
      parsed.is_adult ||
        (parsed.season === null &&
          parsed.episode === null &&
          (aiData.is_adult ||
            (Array.isArray(aiData.genres) && aiData.genres.some((g) => /adult|erotic|xxx|porn/i.test(g)))))
    );

    if (isAdultDetected) {
      return {
        ...parsed,
        is_adult: true,
        type: 'movie',
        series_name: null,
        series_plot: null,
        size_bytes: fileSize,
        plot: 'Private Media content.',
        genres: ['Adult'],
        tags: ['Private', '18+'],
        poster_url: null,
        backdrop_url: null,
      };
    }

    const allowedTypes = new Set(['movie', 'series', 'documentary', 'others']);
    const aiType = allowedTypes.has(aiData.type) ? aiData.type : parsed.type;
    let finalType = parsed.type === 'series' && !matchHint ? 'series' : aiType;
    let seriesName = aiData.series_name || parsed.series_name;

    if (finalType === 'series') {
      // Reconcile with canonical series name if already in catalog (unless overridden by explicit matchHint)
      if (!matchHint && seriesName && mediaDB.getCanonicalSeriesName) {
        const existingCanon = mediaDB.getCanonicalSeriesName(seriesName);
        seriesName = choosePreferredSeriesName(seriesName, existingCanon);
      }
    }

    let finalTitle = aiData.title || parsed.title;

    if (finalType === 'series') {
      const sNum = aiData.season ?? parsed.season;
      const epNum = aiData.episode ?? parsed.episode;
      const epTitle = aiData.episode_title || parsed.episode_title;
      const sName = seriesName || 'TV Series';
      const epLabel =
        sNum !== null && sNum !== undefined && epNum !== null && epNum !== undefined
          ? `S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`
          : '';

      if (epLabel) {
        finalTitle = epTitle ? `${sName} ${epLabel}: ${epTitle}` : `${sName} ${epLabel}`;
      }
    }

    const cleanPoster = aiData.poster_url && !aiData.poster_url.includes('tmdb.org') ? aiData.poster_url : null;
    const cleanBackdrop = aiData.backdrop_url && !aiData.backdrop_url.includes('tmdb.org') ? aiData.backdrop_url : null;
    const resolvedSeriesPlot =
      finalType === 'series'
        ? (!isPlaceholderOrGenericPlot(aiData.series_plot) ? aiData.series_plot : (existingSeries?.series_plot || null))
        : null;

    const result = {
      ...parsed,
      is_adult: false,
      size_bytes: fileSize,
      title: finalTitle,
      type: finalType,
      series_name: finalType === 'series' ? seriesName : null,
      season: finalType === 'series' ? (aiData.season ?? parsed.season) : null,
      episode: finalType === 'series' ? (aiData.episode ?? parsed.episode) : null,
      year: aiData.year ?? existingSeries?.year ?? parsed.year,
      plot: aiData.plot || `Watch ${finalTitle} in high definition on Kodimi.`,
      series_plot: resolvedSeriesPlot,
      genres: Array.isArray(aiData.genres) && aiData.genres.length > 0 ? aiData.genres : ['Entertainment'],
      tags: Array.isArray(aiData.tags) && aiData.tags.length > 0 ? aiData.tags : ['HD', parsed.resolution],
      poster_url: cleanPoster,
      backdrop_url: cleanBackdrop,
    };

    return applyCategoryOverride(result, categoryOverride);
  } catch (err) {
    console.warn(`[AI] Gemini enrichment failed for "${filename}": ${err.message}. Using fallback.`);
    return applyCategoryOverride(generateFallbackMetadata(parsed, fileSize), categoryOverride);
  }
}

export function applyCategoryOverride(meta, categoryOverride = '') {
  if (!meta || !categoryOverride || categoryOverride === 'auto') return meta;
  const cat = String(categoryOverride).toLowerCase().trim();
  const genres = Array.isArray(meta.genres) ? [...meta.genres] : [];
  const tags = Array.isArray(meta.tags) ? [...meta.tags] : [];

  const ensureUnique = (arr, val) => {
    if (!arr.some((x) => String(x).toLowerCase() === val.toLowerCase())) {
      arr.push(val);
    }
  };

  if (cat === 'documentary') {
    ensureUnique(genres, 'Documentary');
    ensureUnique(tags, 'Documentary');
    // Keep multi-episode docuseries grouped as 'series' while tagging Documentary
    return {
      ...meta,
      type: meta.type === 'series' ? 'series' : 'documentary',
      genres,
      tags,
    };
  }
  if (cat === 'others') {
    ensureUnique(tags, 'Others');
    return {
      ...meta,
      type: 'others',
      series_name: null,
      season: null,
      episode: null,
      genres: genres.length > 0 ? genres : ['Others'],
      tags,
    };
  }
  if (cat === 'movie') {
    return { ...meta, type: 'movie', series_name: null, season: null, episode: null };
  }
  if (cat === 'series') {
    return { ...meta, type: 'series', series_name: meta.series_name || meta.title };
  }
  return meta;
}

function generateFallbackMetadata(parsed, fileSize) {
  let seriesName = parsed.series_name;
  let title = parsed.title;
  let existingSeries = null;

  if (parsed.type === 'series' && seriesName) {
    if (mediaDB.getSeriesInfo) {
      existingSeries = mediaDB.getSeriesInfo(seriesName);
    }
    if (mediaDB.getCanonicalSeriesName) {
      seriesName = mediaDB.getCanonicalSeriesName(seriesName);
    }
    const epLabel =
      parsed.season !== null && parsed.episode !== null
        ? `S${String(parsed.season).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`
        : '';
    if (epLabel) {
      title = parsed.episode_title ? `${seriesName} ${epLabel}: ${parsed.episode_title}` : `${seriesName} ${epLabel}`;
    }
  }

  const genres = existingSeries?.genres?.length ? existingSeries.genres : inferGenres(title);
  return {
    ...parsed,
    title,
    series_name: parsed.type === 'series' ? seriesName : null,
    year: parsed.year ?? existingSeries?.year ?? null,
    size_bytes: fileSize,
    plot: `Enjoy ${title} streaming in ${parsed.resolution} on your personal Kodimi media center.`,
    series_plot: existingSeries?.series_plot ?? null,
    genres,
    tags: [parsed.resolution, parsed.video_codec.toUpperCase(), ...genres],
    poster_url: existingSeries?.poster_url ?? getPlaceholderPoster(title),
    backdrop_url: existingSeries?.backdrop_url ?? getPlaceholderBackdrop(title),
  };
}

function inferGenres(title) {
  const lower = title.toLowerCase();
  if (/war|kill|battle|clarence|jackal|equalizer|gun|fight/i.test(lower)) return ['Action', 'Thriller'];
  if (/marvel|x-men|super|power|rings|lord|creator/i.test(lower)) return ['Sci-Fi', 'Adventure'];
  if (/game|fall|union|trap|long/i.test(lower)) return ['Drama', 'Thriller'];
  if (/boy|heron|wonka|tiger/i.test(lower)) return ['Animation', 'Family'];
  return ['Action', 'Drama'];
}

function getPlaceholderPoster(title) {
  const encoded = encodeURIComponent(title.slice(0, 30));
  return `https://placehold.co/600x900/18181b/ffffff?text=${encoded}`;
}

function getPlaceholderBackdrop(title) {
  const encoded = encodeURIComponent(title.slice(0, 30));
  return `https://placehold.co/1280x720/141414/e50914?text=${encoded}`;
}

export default {
  MEDIA_METADATA_JSON_SCHEMA,
  heuristicParseFilename,
  isPlaceholderOrGenericPlot,
  extractJsonObject,
  enrichMediaMetadata,
  applyCategoryOverride,
  resetAIClient,
};
