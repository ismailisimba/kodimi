import { GoogleGenAI } from '@google/genai';
import crypto from 'crypto';
import { config } from '../config/env.js';

let aiClient = null;

function getAIClient() {
  if (!aiClient && config.geminiApiKey) {
    try {
      aiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
    } catch (err) {
      console.warn('[AI] Failed to initialize GoogleGenAI client:', err.message);
    }
  }
  return aiClient;
}

/**
 * Heuristic parser from filename
 */
export function heuristicParseFilename(filename) {
  const base = filename.replace(/\.[^/.]+$/, ''); // remove extension
  let clean = base.replace(/[\._]/g, ' ');

  // Detect adult content tags
  const isAdult = /\[?(blacked|brazzers|tushy|fakehub|woodman|teenslikeitbig)\]?/i.test(filename) ||
                  /\b(anal|hardcore)\b/i.test(clean);

  // Detect Season & Episode (e.g. S01E02 or 1x02)
  const seMatch = clean.match(/\bS(\d{1,2})E(\d{1,2})\b/i) || clean.match(/\b(\d{1,2})x(\d{1,2})\b/i);
  let season = null;
  let episode = null;
  let type = 'movie';

  if (seMatch) {
    season = parseInt(seMatch[1], 10);
    episode = parseInt(seMatch[2], 10);
    type = 'series';
  }

  // Detect Year
  const yearMatch = clean.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Detect Resolution
  const resMatch = clean.match(/\b(2160p|4k|1080p|720p|480p|360p)\b/i);
  const resolution = resMatch ? resMatch[1].toLowerCase() : '1080p';

  // Detect Codec
  const codecMatch = clean.match(/\b(x265|hevc|h265|x264|h264|av1)\b/i);
  const video_codec = codecMatch ? codecMatch[1].toLowerCase() : 'x264';

  // Extract clean title by taking words before year or season
  let title = clean;
  let episodeTitle = null;
  if (seMatch) {
    const idx = clean.search(/\bS\d{1,2}E\d{1,2}\b/i);
    if (idx > 0) title = clean.substring(0, idx);

    // Extract whatever comes after the SxxExx tag (e.g. Sayonara)
    const afterSe = clean.substring(idx + seMatch[0].length).trim();
    const cleanAfter = afterSe.replace(/\b(2160p|4k|1080p|720p|480p|360p|WEBRip|BluRay|AMZN|NF|WEB-DL|AAC|DD5|10bit|DDP5|x265|x264|hevc|h264|MiNX|GalaxyRG|MeGusta|TGx|PSA|ELiTE|Rapta|NeoNoir).*/i, '').trim();
    if (cleanAfter.length > 0) {
      episodeTitle = cleanAfter;
    }
  } else if (yearMatch) {
    const idx = clean.search(/\b(19\d\d|20\d\d)\b/);
    if (idx > 0) title = clean.substring(0, idx);
  }

  // Clean trailing release groups and tags
  title = title.replace(/\b(WEBRip|BluRay|AMZN|NF|WEB-DL|AAC|DD5|10bit|MiNX|GalaxyRG|MeGusta|TGx|PSA|ELiTE|Rapta)\b.*$/i, '');
  title = title.trim();

  let formattedTitle = title || base;
  if (type === 'series') {
    const epLabel = season && episode ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : '';
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

/**
 * Enriches media metadata using Google Gemini AI.
 * Falls back to heuristic parsing if API is unavailable.
 */
export async function enrichMediaMetadata(filename, fileSize = 0) {
  const parsed = heuristicParseFilename(filename);

  // If adult content, avoid sending to general safety filters and generate structured tags
  if (parsed.is_adult) {
    return {
      ...parsed,
      size_bytes: fileSize,
      plot: 'Private Media content.',
      genres: ['Adult'],
      tags: ['Private', '18+'],
      poster_url: 'https://images.unsplash.com/photo-1518173946687-a4c8892bbd9f?w=600&auto=format&fit=crop&q=80',
      backdrop_url: 'https://images.unsplash.com/photo-1518173946687-a4c8892bbd9f?w=1200&auto=format&fit=crop&q=80',
    };
  }

  const client = getAIClient();
  if (!client) {
    // Generate fallback visuals
    return generateFallbackMetadata(parsed, fileSize);
  }

  try {
    const prompt = `You are an expert movie and TV media cataloger for a personal streaming platform named Kodimi.
Analyze this video file name: "${filename}".
Detected Season: ${parsed.season || 'null'}, Episode: ${parsed.episode || 'null'}, Inferred Series: "${parsed.series_name || ''}", Inferred Episode Title: "${parsed.episode_title || ''}".

IMPORTANT RULES FOR TV SERIES EPISODES:
1. If this is a TV series episode (contains SxxExx or season/episode pattern):
   - Set "type": "series"
   - Set "series_name": Canonical name of the TV show (e.g. "Slow Horses")
   - Set "season": Season number (integer, e.g. 6)
   - Set "episode": Episode number (integer, e.g. 5)
   - Set "episode_title": The actual title of this specific episode (e.g. "Sayonara")
   - Set "title": MUST be formatted as: "{series_name} S{XX}E{XX}: {episode_title}" (e.g. "Slow Horses S06E05: Sayonara"). If episode title is unknown, use "{series_name} S{XX}E{XX}".
   - Set "plot": An accurate 2-3 sentence synopsis/plot overview of THIS SPECIFIC EPISODE (what happens in this episode, not just the generic series premise).
2. If this is a standalone Movie:
   - Set "type": "movie"
   - Set "series_name": null, "season": null, "episode": null, "episode_title": null
   - Set "title": Canonical movie title
   - Set "plot": Accurate 2-3 sentence synopsis of the movie.

Return a strictly valid JSON object with fields:
{
  "title": string,
  "type": "movie" or "series",
  "series_name": string or null,
  "season": integer or null,
  "episode": integer or null,
  "episode_title": string or null,
  "year": integer or null,
  "plot": string,
  "genres": string[],
  "tags": string[],
  "poster_url": string,
  "backdrop_url": string
}

Do NOT enclose in markdown backticks or code fences. Output ONLY the raw JSON string.`;

    const response = await client.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
    });

    const text = response.text?.trim() || '';
    const cleanJson = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const aiData = JSON.parse(cleanJson);

    let seriesName = aiData.series_name || parsed.series_name;
    let finalTitle = aiData.title || parsed.title;

    if (parsed.type === 'series' || aiData.type === 'series') {
      const sNum = aiData.season ?? parsed.season;
      const epNum = aiData.episode ?? parsed.episode;
      const epTitle = aiData.episode_title || parsed.episode_title;
      const sName = seriesName || 'TV Series';
      const epLabel = sNum && epNum ? `S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}` : '';

      if (epLabel) {
        finalTitle = epTitle ? `${sName} ${epLabel}: ${epTitle}` : `${sName} ${epLabel}`;
      }
    }

    const cleanPoster = (aiData.poster_url && !aiData.poster_url.includes('tmdb.org')) ? aiData.poster_url : null;
    const cleanBackdrop = (aiData.backdrop_url && !aiData.backdrop_url.includes('tmdb.org')) ? aiData.backdrop_url : null;

    return {
      ...parsed,
      size_bytes: fileSize,
      title: finalTitle,
      type: aiData.type || parsed.type,
      series_name: seriesName,
      season: aiData.season ?? parsed.season,
      episode: aiData.episode ?? parsed.episode,
      year: aiData.year ?? parsed.year,
      plot: aiData.plot || `Watch ${finalTitle} in high definition on Kodimi.`,
      genres: Array.isArray(aiData.genres) && aiData.genres.length > 0 ? aiData.genres : ['Entertainment'],
      tags: Array.isArray(aiData.tags) && aiData.tags.length > 0 ? aiData.tags : ['HD', parsed.resolution],
      poster_url: cleanPoster,
      backdrop_url: cleanBackdrop,
    };
  } catch (err) {
    console.warn(`[AI] Gemini enrichment failed for "${filename}": ${err.message}. Using fallback.`);
    return generateFallbackMetadata(parsed, fileSize);
  }
}

function generateFallbackMetadata(parsed, fileSize) {
  const genres = inferGenres(parsed.title);
  return {
    ...parsed,
    size_bytes: fileSize,
    plot: `Enjoy ${parsed.title} streaming in ${parsed.resolution} on your personal Kodimi media center.`,
    genres,
    tags: [parsed.resolution, parsed.video_codec.toUpperCase(), ...genres],
    poster_url: getPlaceholderPoster(parsed.title),
    backdrop_url: getPlaceholderBackdrop(parsed.title),
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
  heuristicParseFilename,
  enrichMediaMetadata,
};
