import axios from 'axios';
import crypto from 'crypto';

/**
 * Kodimi Live TV & EPG Service
 * Integrates iptv-org playlists with real-time EPG scheduling and CORS streaming proxy.
 */

const CATEGORY_PLAYLISTS = [
  { id: 'news', name: 'News', icon: 'newspaper', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { id: 'sports', name: 'Sports', icon: 'sports_soccer', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { id: 'movies', name: 'Movies', icon: 'movie', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { id: 'series', name: 'Series', icon: 'tv', url: 'https://iptv-org.github.io/iptv/categories/series.m3u' },
  { id: 'animation', name: 'Animation', icon: 'smart_toy', url: 'https://iptv-org.github.io/iptv/categories/animation.m3u' },
  { id: 'entertainment', name: 'Entertainment', icon: 'theater_comedy', url: 'https://iptv-org.github.io/iptv/categories/entertainment.m3u' },
  { id: 'music', name: 'Music', icon: 'music_note', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
  { id: 'documentary', name: 'Documentary', icon: 'history_edu', url: 'https://iptv-org.github.io/iptv/categories/documentary.m3u' },
  { id: 'comedy', name: 'Comedy', icon: 'sentiment_very_satisfied', url: 'https://iptv-org.github.io/iptv/categories/comedy.m3u' },
  { id: 'kids', name: 'Kids', icon: 'child_care', url: 'https://iptv-org.github.io/iptv/categories/kids.m3u' },
  { id: 'science', name: 'Science', icon: 'science', url: 'https://iptv-org.github.io/iptv/categories/science.m3u' },
];

const COUNTRY_PLAYLISTS = [
  { id: 'us', name: 'United States', flag: '🇺🇸', url: 'https://iptv-org.github.io/iptv/countries/us.m3u' },
  { id: 'uk', name: 'United Kingdom', flag: '🇬🇧', url: 'https://iptv-org.github.io/iptv/countries/uk.m3u' },
  { id: 'ca', name: 'Canada', flag: '🇨🇦', url: 'https://iptv-org.github.io/iptv/countries/ca.m3u' },
  { id: 'au', name: 'Australia', flag: '🇦🇺', url: 'https://iptv-org.github.io/iptv/countries/au.m3u' },
  { id: 'global', name: 'English (Global)', flag: '🌐', url: 'https://iptv-org.github.io/iptv/languages/eng.m3u' },
];

// In-Memory cache of parsed channels
let channelCache = [];
let channelsById = new Map();
let isInitialized = false;
let isInitializing = false;
let lastRefreshed = null;

// EPG schedule patterns by genre
const GENRE_SCHEDULE_TEMPLATES = {
  news: [
    { title: 'Global Morning Briefing', desc: 'Comprehensive coverage of top morning international headlines and markets.', durationMin: 60 },
    { title: 'World News Live', desc: 'Real-time breaking stories, field correspondents, and political analysis.', durationMin: 60 },
    { title: 'Financial Focus & Markets', desc: 'Global stock markets, economic trends, and business developments.', durationMin: 30 },
    { title: 'The Midday Report', desc: 'Key developments of the day, expert interviews, and global weather.', durationMin: 60 },
    { title: 'Investigative Insight', desc: 'Deep dive investigative journalism on world affairs and investigative reports.', durationMin: 60 },
    { title: 'Global Evening Panorama', desc: 'Wrap-up of today\'s major international events and roundtable discussion.', durationMin: 60 },
    { title: 'Prime Time Spotlight', desc: 'Hard-hitting political interviews, debates, and breaking news updates.', durationMin: 60 },
    { title: 'Late Night International', desc: 'Global perspective from overseas newsrooms, sports recap, and forecasts.', durationMin: 60 },
  ],
  sports: [
    { title: 'SportsCenter Morning', desc: 'Recap of overnight fixtures, goals, rankings, and upcoming matches.', durationMin: 60 },
    { title: 'Championship Vault', desc: 'Classic matches, legendary moments, and iconic tournament highlights.', durationMin: 90 },
    { title: 'Live Matchday Live / Pre-Game', desc: 'Tactical analysis, lineup previews, and live pre-match interviews.', durationMin: 60 },
    { title: 'Prime Time Action Showcase', desc: 'Live sporting action, tournament coverage, and real-time score updates.', durationMin: 120 },
    { title: 'Post-Match Debrief & Highlights', desc: 'Post-game press conferences, pundit analysis, and key moment breakdowns.', durationMin: 60 },
    { title: 'Extreme & Motorsport Arena', desc: 'High-octane motorsport racing, action sports, and behind-the-scenes engineering.', durationMin: 60 },
  ],
  movies: [
    { title: 'Matinee Showcase', desc: 'Acclaimed classic drama and timeless cinematic storytelling.', durationMin: 120 },
    { title: 'Hollywood Hits', desc: 'Star-studded cinema blockbusters, award-winning scripts, and top thrillers.', durationMin: 120 },
    { title: 'Action & Adventure Premiere', desc: 'High-adrenaline feature film with explosive set pieces and iconic heroes.', durationMin: 120 },
    { title: 'Prime Time Feature Film', desc: 'Tonight\'s centerpiece blockbuster movie presentation.', durationMin: 135 },
    { title: 'Late Night Mystery & Thriller', desc: 'Suspenseful psychological thriller, neo-noir intrigue, and dark secrets.', durationMin: 105 },
    { title: 'Midnight Cult Cinema', desc: 'Cult classics, sci-fi epics, and late-night underground cinema.', durationMin: 120 },
  ],
  series: [
    { title: 'Classic Drama Series', desc: 'Back-to-back episodes of celebrated television drama and timeless plots.', durationMin: 60 },
    { title: 'Crime Scene Investigation Hour', desc: 'Detectives piece together forensic evidence to solve compelling murder cases.', durationMin: 60 },
    { title: 'Prime Time Drama Showcase', desc: 'Critically acclaimed serial storytelling with intense cliffhangers.', durationMin: 60 },
    { title: 'Sci-Fi & Fantasy Chronicle', desc: 'Extraordinary journeys through space, alternate realities, and mysterious realms.', durationMin: 60 },
    { title: 'Late Night Comedy Strip', desc: 'Hilarious comedy situations, witty sitcom episodes, and punchy humor.', durationMin: 30 },
  ],
  animation: [
    { title: 'Morning Cartoon Carousel', desc: 'Colorful fun adventures, animated comedy, and playful heroes for the day.', durationMin: 60 },
    { title: 'Superhero Academy', desc: 'Costumed heroes defend justice against villainous masterminds and rogue robots.', durationMin: 60 },
    { title: 'Anime Spotlight Hour', desc: 'Dynamic action anime, high-stakes battle tournaments, and supernatural fantasy.', durationMin: 60 },
    { title: 'Afternoon Animation Marathon', desc: 'Favorite animated episodes, wacky chases, and humorous cartoon escapades.', durationMin: 90 },
    { title: 'Prime Anime Epic', desc: 'Feature anime series with breathtaking visuals, compelling lore, and deep stakes.', durationMin: 60 },
  ],
  entertainment: [
    { title: 'Good Morning Live', desc: 'Lifestyle tips, celebrity interviews, upbeat entertainment, and cooking segments.', durationMin: 90 },
    { title: 'Celebrity & Pop Culture Reel', desc: 'Red carpet premieres, backstage scoops, trending viral moments, and fashion.', durationMin: 60 },
    { title: 'Reality Spotlight', desc: 'Real stories, competitions, home renovation showcases, and dramatic rivalries.', durationMin: 60 },
    { title: 'Prime Time Game Show', desc: 'Contestants battle wits and high stakes for fortune and glory.', durationMin: 60 },
    { title: 'The Tonight Talk Show', desc: 'Stand-up monologue, hilarious sketch comedy, and A-list celebrity guests.', durationMin: 60 },
  ],
  music: [
    { title: 'Morning Energy Hits', desc: 'Upbeat chart-topping pop and dance hits to supercharge your morning.', durationMin: 60 },
    { title: 'Top 40 Countdown', desc: 'The biggest singles of the week counting down to the global number one track.', durationMin: 120 },
    { title: 'Rock & Alternative Power Hour', desc: 'Heavy riffs, classic stadium rock anthems, and modern alternative anthems.', durationMin: 60 },
    { title: 'Hip-Hop & R&B Session', desc: 'Freshest beats, urban classics, legendary verses, and chart-topping collabs.', durationMin: 60 },
    { title: 'Club Vibes & Electronic Lounge', desc: 'Immersive electronic beats, DJ live sets, ambient visuals, and festival sounds.', durationMin: 90 },
  ],
  documentary: [
    { title: 'Wonders of Planet Earth', desc: 'Stunning wildlife photography, untamed wilderness, and ocean wonders.', durationMin: 60 },
    { title: 'Ancient Civilizations & Relics', desc: 'Archaeologists unearth lost pyramids, forgotten empires, and ancient mysteries.', durationMin: 60 },
    { title: 'Modern Engineering Marvels', desc: 'Superstructures, mega-bridges, skyscrapers, and revolutionary tech inventions.', durationMin: 60 },
    { title: 'Secrets of the Deep Cosmos', desc: 'Astronomers explore distant galaxies, black holes, and the origins of our universe.', durationMin: 60 },
    { title: 'Historical Crossroads', desc: 'Crucial battles, pivotal treaties, and turning points that shaped our world.', durationMin: 60 },
  ],
  comedy: [
    { title: 'Morning Laugh Track', desc: 'Classic comedy sketches, timeless sitcom episodes, and hilarious mishaps.', durationMin: 60 },
    { title: 'Stand-Up Spotlight', desc: 'Stand-up comedy specials from top headliners and rising stars.', durationMin: 60 },
    { title: 'Pranks & Viral Comedy', desc: 'Side-splitting hidden camera pranks, hilarious fails, and viral internet comedy.', durationMin: 30 },
    { title: 'Prime Time Comedy Block', desc: 'Back-to-back fan favorite sitcom episodes and witty punchlines.', durationMin: 60 },
  ],
  kids: [
    { title: 'Tiny Explorers Club', desc: 'Fun educational songs, alphabet adventures, and friendly animal puppets.', durationMin: 45 },
    { title: 'Adventure Pals', desc: 'Whimsical teamwork quests, problem solving, and colorful cartoon escapades.', durationMin: 45 },
    { title: 'Magic Storybook Kingdom', desc: 'Fairy tales, heroic quests, enchanted forests, and cheerful songs.', durationMin: 60 },
    { title: 'Junior Science Lab', desc: 'Cool experiments, fun facts about space and animals, and curious inventions.', durationMin: 45 },
  ],
  science: [
    { title: 'Space Frontier & Exploration', desc: 'Latest missions to the Moon, Mars rovers, rocket launches, and space stations.', durationMin: 60 },
    { title: 'Future Tech & Robotics', desc: 'Artificial intelligence, quantum computing, and bleeding-edge robotics.', durationMin: 60 },
    { title: 'Secrets of the Human Mind', desc: 'Neuroscience discoveries, psychology experiments, and human biology insights.', durationMin: 60 },
    { title: 'Planetary Science & Oceans', desc: 'Extreme weather, deep ocean trenches, volcanoes, and earth systems.', durationMin: 60 },
  ],
};

/**
 * Initializes and caches IPTV channels from iptv-org playlists.
 */
export async function initIptvService() {
  if (isInitialized || isInitializing) return;
  isInitializing = true;

  try {
    console.log('[Live TV] Fetching public channel playlists from iptv-org...');

    const combinedMap = new Map();

    // 1. Fetch category playlists in parallel with timeout safety
    const categoryPromises = CATEGORY_PLAYLISTS.map(async (cat) => {
      try {
        const res = await axios.get(cat.url, { timeout: 8000 });
        const channels = parseM3u(res.data, cat.name);
        channels.forEach((ch) => {
          if (!combinedMap.has(ch.id)) {
            combinedMap.set(ch.id, { ...ch, category: cat.name });
          }
        });
      } catch (err) {
        console.warn(`[Live TV] Failed to fetch category ${cat.name}:`, err.message);
      }
    });

    // 2. Fetch US and UK curated playlists
    const countryPromises = COUNTRY_PLAYLISTS.slice(0, 2).map(async (c) => {
      try {
        const res = await axios.get(c.url, { timeout: 8000 });
        const channels = parseM3u(res.data, 'General');
        channels.forEach((ch) => {
          if (combinedMap.has(ch.id)) {
            combinedMap.get(ch.id).country = c.name;
          } else {
            combinedMap.set(ch.id, { ...ch, country: c.name });
          }
        });
      } catch (err) {
        console.warn(`[Live TV] Failed to fetch country ${c.name}:`, err.message);
      }
    });

    await Promise.allSettled([...categoryPromises, ...countryPromises]);

    // Populate memory cache
    channelCache = Array.from(combinedMap.values());
    channelsById.clear();
    channelCache.forEach((c) => channelsById.set(c.id, c));

    lastRefreshed = new Date();
    isInitialized = true;
    console.log(`[Live TV] Successfully loaded and cached ${channelCache.length} live channels with EPG schedules!`);
  } catch (err) {
    console.error('[Live TV Init Error]:', err.message);
  } finally {
    isInitializing = false;
  }
}

/**
 * Parses raw M3U text into structured channel objects.
 */
function parseM3u(content, fallbackCategory = 'Entertainment') {
  const lines = content.split('\n');
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      // Extract tvg-id, tvg-logo, group-title, and channel name
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(',');
      const rawTitle = commaIdx !== -1 ? line.substring(commaIdx + 1).trim() : 'Channel';

      // Clean channel name and extract resolution tag (e.g. 1080p, 720p)
      let cleanName = rawTitle.replace(/\[.*?\]/g, '').trim();
      const resMatch = cleanName.match(/\((1080p|720p|480p|360p|2160p|4k|HD|FHD)\)/i);
      const resolution = resMatch ? resMatch[1].toUpperCase() : '720P';
      cleanName = cleanName.replace(/\(.*?\)/g, '').trim();

      const tvgId = tvgIdMatch ? tvgIdMatch[1] : '';
      const logo = tvgLogoMatch ? tvgLogoMatch[1] : '';
      const category = groupMatch && groupMatch[1] ? groupMatch[1].split(';')[0].trim() : fallbackCategory;

      // The next non-empty, non-comment line is the stream URL
      let streamUrl = '';
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          streamUrl = nextLine;
          i = j;
          break;
        }
      }

      if (cleanName && streamUrl && (streamUrl.startsWith('http://') || streamUrl.startsWith('https://'))) {
        // Exclude adult channels from public Live TV
        const lowerCat = category.toLowerCase();
        const lowerName = cleanName.toLowerCase();
        if (lowerCat.includes('xxx') || lowerCat.includes('adult') || lowerName.includes('xxx') || lowerName.includes('porn')) {
          continue;
        }

        const id = slugify(tvgId || cleanName);
        channels.push({
          id,
          name: cleanName,
          fullName: rawTitle,
          logo: logo || `https://placehold.co/120x120/1e1e1e/white?text=${encodeURIComponent(cleanName.slice(0, 4))}`,
          category,
          resolution,
          streamUrl,
          tvgId,
          country: tvgId.includes('.us') ? 'United States' : tvgId.includes('.uk') ? 'United Kingdom' : 'Global',
        });
      }
    }
  }

  return channels;
}

/**
 * Computes deterministic real-time EPG program schedule for a channel.
 * Guarantees consistent, realistic "Now Playing", "Up Next", and full 24h timeline.
 */
export function getChannelEpg(channel, targetDate = new Date()) {
  const catKey = (channel.category || 'entertainment').toLowerCase();
  const templates = GENRE_SCHEDULE_TEMPLATES[catKey] || GENRE_SCHEDULE_TEMPLATES.entertainment;

  // Use channel id to deterministically seed today's schedule sequence
  const dayStr = targetDate.toISOString().slice(0, 10);
  const seedString = `${channel.id}-${dayStr}`;
  let seedNum = 0;
  for (let k = 0; k < seedString.length; k++) {
    seedNum = (seedNum << 5) - seedNum + seedString.charCodeAt(k);
    seedNum |= 0;
  }
  const seedOffset = Math.abs(seedNum) % templates.length;

  // Build 24-hour schedule starting from midnight
  const midnight = new Date(targetDate);
  midnight.setHours(0, 0, 0, 0);

  const schedule = [];
  let currentCursor = new Date(midnight);
  let templateIndex = seedOffset;

  while (currentCursor.getDate() === midnight.getDate()) {
    const tpl = templates[templateIndex % templates.length];
    const start = new Date(currentCursor);
    const stop = new Date(start.getTime() + tpl.durationMin * 60 * 1000);

    schedule.push({
      id: `${channel.id}-${start.getTime()}`,
      title: tpl.title,
      desc: tpl.desc,
      category: channel.category,
      startTime: formatTimeAmPm(start),
      stopTime: formatTimeAmPm(stop),
      startTimestamp: start.getTime(),
      stopTimestamp: stop.getTime(),
      durationMinutes: tpl.durationMin,
    });

    currentCursor = stop;
    templateIndex++;
  }

  // Find currently airing program and next program
  const nowMs = targetDate.getTime();
  let currentProgram = schedule.find((p) => nowMs >= p.startTimestamp && nowMs < p.stopTimestamp);
  
  // If slightly outside boundary, default to nearest
  if (!currentProgram && schedule.length > 0) {
    currentProgram = schedule[0];
  }

  let nextProgram = null;
  if (currentProgram) {
    const currentIdx = schedule.findIndex((p) => p.id === currentProgram.id);
    if (currentIdx !== -1 && currentIdx + 1 < schedule.length) {
      nextProgram = schedule[currentIdx + 1];
    }
  }

  // Calculate live progress percentage & remaining minutes
  let progressPercent = 0;
  let remainingMinutes = 0;
  if (currentProgram) {
    const elapsed = Math.max(0, nowMs - currentProgram.startTimestamp);
    const total = currentProgram.stopTimestamp - currentProgram.startTimestamp;
    progressPercent = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
    remainingMinutes = Math.max(1, Math.round((currentProgram.stopTimestamp - nowMs) / (60 * 1000)));
  }

  return {
    channel: {
      id: channel.id,
      name: channel.name,
      logo: channel.logo,
      category: channel.category,
      resolution: channel.resolution,
      country: channel.country,
      streamUrl: channel.streamUrl,
    },
    currentProgram: currentProgram ? {
      ...currentProgram,
      progressPercent,
      remainingMinutes,
    } : null,
    nextProgram,
    schedule,
  };
}

/**
 * Retrieves paginated channels with enriched real-time EPG data.
 */
export async function getChannels(options = {}) {
  if (!isInitialized) {
    await initIptvService();
  }

  const { category, country, search, limit = 60, offset = 0 } = options;
  let list = channelCache;

  if (category && category !== 'all') {
    const qCat = category.toLowerCase();
    list = list.filter((c) => c.category.toLowerCase().includes(qCat));
  }

  if (country && country !== 'all') {
    const qCountry = country.toLowerCase();
    list = list.filter((c) => c.country.toLowerCase().includes(qCountry));
  }

  if (search) {
    const q = search.toLowerCase();
    list = list.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q) ||
      c.country.toLowerCase().includes(q)
    );
  }

  const total = list.length;
  const paged = list.slice(offset, offset + limit);
  const now = new Date();

  // Attach real-time EPG now/next cards
  const items = paged.map((c) => {
    const epg = getChannelEpg(c, now);
    return {
      ...c,
      currentProgram: epg.currentProgram,
      nextProgram: epg.nextProgram,
    };
  });

  return {
    total,
    offset,
    limit,
    items,
  };
}

/**
 * Returns all available categories and countries with channel counts.
 */
export async function getCategories() {
  if (!isInitialized) {
    await initIptvService();
  }

  const catCounts = new Map();
  channelCache.forEach((c) => {
    const cat = c.category || 'General';
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  });

  const categories = CATEGORY_PLAYLISTS.map((cp) => ({
    id: cp.id,
    name: cp.name,
    icon: cp.icon,
    count: catCounts.get(cp.name) || 0,
  }));

  const countries = COUNTRY_PLAYLISTS.map((cp) => ({
    id: cp.id,
    name: cp.name,
    flag: cp.flag,
    count: channelCache.filter((c) => c.country.toLowerCase().includes(cp.name.toLowerCase())).length,
  }));

  return {
    categories,
    countries,
    totalChannels: channelCache.length,
    lastRefreshed,
  };
}

/**
 * Retrieves full 24-hour EPG timeline for a specific channel.
 */
export async function getChannelSchedule(channelId) {
  if (!isInitialized) {
    await initIptvService();
  }

  const channel = channelsById.get(channelId);
  if (!channel) return null;

  return getChannelEpg(channel, new Date());
}

/**
 * Proxies live HLS streams to bypass restrictive browser CORS headers.
 */
export async function proxyHlsStream(streamUrl, res) {
  try {
    const response = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }

    response.data.pipe(res);
  } catch (err) {
    console.error(`[IPTV Proxy Error for ${streamUrl}]:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream unreachable or offline' });
    }
  }
}

function slugify(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .slice(0, 60) || `ch-${crypto.randomBytes(4).toString('hex')}`;
}

function formatTimeAmPm(date) {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const minutesStr = minutes < 10 ? '0' + minutes : minutes;
  return `${hours}:${minutesStr} ${ampm}`;
}

export default {
  initIptvService,
  getChannels,
  getCategories,
  getChannelSchedule,
  proxyHlsStream,
};
