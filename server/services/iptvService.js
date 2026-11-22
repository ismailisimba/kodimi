import axios from 'axios';
import crypto from 'crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import ffmpeg from 'fluent-ffmpeg';
import { iptvHealthDB } from '../db/database.js';

/**
 * Kodimi Live TV & EPG Service
 * Integrates verified multi-category curated streams + iptv-org playlists across 6 countries / 3 continents
 * with instance-local liveness probing (europe-west4 ready), SSRF-safe HLS proxy, redirect-aware manifest
 * rewriting, #EXTVLCOPT header forwarding, fallback URLs, and runtime circuit breaker.
 */

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CATEGORY_PLAYLISTS = [
  { id: 'sports', name: 'Sports', icon: 'sports_soccer', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { id: 'news', name: 'News', icon: 'newspaper', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { id: 'entertainment', name: 'Entertainment', icon: 'theater_comedy', url: 'https://iptv-org.github.io/iptv/categories/entertainment.m3u' },
  { id: 'learning', name: 'Learning & Docs', icon: 'school', url: 'https://iptv-org.github.io/iptv/categories/education.m3u' },
  { id: 'documentary', name: 'Documentary', icon: 'history_edu', url: 'https://iptv-org.github.io/iptv/categories/documentary.m3u' },
  { id: 'science', name: 'Science', icon: 'science', url: 'https://iptv-org.github.io/iptv/categories/science.m3u' },
  { id: 'movies', name: 'Movies', icon: 'movie', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { id: 'series', name: 'Series', icon: 'tv', url: 'https://iptv-org.github.io/iptv/categories/series.m3u' },
  { id: 'animation', name: 'Animation', icon: 'smart_toy', url: 'https://iptv-org.github.io/iptv/categories/animation.m3u' },
  { id: 'music', name: 'Music', icon: 'music_note', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
  { id: 'comedy', name: 'Comedy', icon: 'sentiment_very_satisfied', url: 'https://iptv-org.github.io/iptv/categories/comedy.m3u' },
  { id: 'kids', name: 'Kids', icon: 'child_care', url: 'https://iptv-org.github.io/iptv/categories/kids.m3u' },
];

// 6 Countries across 3 Continents (North America: US, CA | Europe: UK, DE | Asia-Pacific: AU, JP) + Global English
const COUNTRY_PLAYLISTS = [
  { id: 'us', name: 'United States', continent: 'North America', flag: '🇺🇸', url: 'https://iptv-org.github.io/iptv/countries/us.m3u' },
  { id: 'ca', name: 'Canada', continent: 'North America', flag: '🇨🇦', url: 'https://iptv-org.github.io/iptv/countries/ca.m3u' },
  { id: 'uk', name: 'United Kingdom', continent: 'Europe', flag: '🇬🇧', url: 'https://iptv-org.github.io/iptv/countries/uk.m3u' },
  { id: 'de', name: 'Germany', continent: 'Europe', flag: '🇩🇪', url: 'https://iptv-org.github.io/iptv/countries/de.m3u' },
  { id: 'au', name: 'Australia', continent: 'Asia-Pacific', flag: '🇦🇺', url: 'https://iptv-org.github.io/iptv/countries/au.m3u' },
  { id: 'jp', name: 'Japan', continent: 'Asia-Pacific', flag: '🇯🇵', url: 'https://iptv-org.github.io/iptv/countries/jp.m3u' },
  { id: 'global', name: 'Global English', continent: 'Global', flag: '🌐', url: 'https://iptv-org.github.io/iptv/languages/eng.m3u' },
];

// Known dead, Cloudflare-blocked, or region-locked CDN hosts excluded during M3U ingestion
const BLOCKED_STREAM_HOSTS = [
  'primetv.cc.cd',
  'andro.mangeinde4.lat',
  'cdn-redge.media',
  'lb.iptvnetwork.net',
  'aynascope.net',
];

// Live-verified, multi-category, globally accessible FAST/FTA showcase channels
export const CURATED_CHANNELS = [
  // Sports
  {
    id: 'bein-sports-xtra',
    name: 'beIN SPORTS XTRA HD',
    fullName: 'beIN SPORTS XTRA (1080p)',
    category: 'Sports',
    resolution: '1080P',
    streamUrl: 'https://bein-xtra-bein.amagi.tv/playlist.m3u8',
    fallbackUrls: ['https://d9ssxzmclhfo4.cloudfront.net/bein_sports.m3u8'],
    logo: 'https://placehold.co/120x120/5c2d91/white?text=beIN',
    country: 'United States',
    tvgId: 'beINSPORTSXTRA.us',
    curated: true,
  },
  {
    id: 'bein-sports-xtra-espanol',
    name: 'beIN SPORTS XTRA en Español',
    fullName: 'beIN SPORTS XTRA en Español (1080p)',
    category: 'Sports',
    resolution: '1080P',
    streamUrl: 'https://dc1644a9jazgj.cloudfront.net/beIN_Sports_Xtra_Espanol.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/5c2d91/white?text=beIN',
    country: 'United States',
    tvgId: 'beINSPORTSXTRAenEspanol.us',
    curated: true,
  },
  {
    id: 'espn8-the-ocho',
    name: 'ESPN8: The Ocho',
    fullName: 'ESPN8: The Ocho (1080p)',
    category: 'Sports',
    resolution: '1080P',
    streamUrl: 'https://d3b6q2ou5kp8ke.cloudfront.net/ESPNTheOcho.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/d00000/white?text=OCHO',
    country: 'United States',
    tvgId: 'ESPN8TheOcho.us',
    curated: true,
  },
  {
    id: 'fifa-plus-live',
    name: 'FIFA+ Live HD',
    fullName: 'FIFA+ Live (720p)',
    category: 'Sports',
    resolution: '720P',
    streamUrl:
      'https://4397879b.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmFrdXRlblRWLWRlX0ZJRkFQbHVzR2VybWFuX0hMUw/playlist.m3u8',
    fallbackUrls: [
      'https://d2w9q46ikgrcwx.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-of5cbk3sav3w5/v1/sysdata_s_p_a_fifa_7/samsungheadend_us/latest/main/hls/playlist.m3u8',
    ],
    logo: 'https://placehold.co/120x120/00529b/white?text=FIFA+',
    country: 'Germany',
    tvgId: 'FIFAPlus.de',
    curated: true,
  },
  {
    id: 'fuel-tv-au',
    name: 'FUEL TV Action Sports',
    fullName: 'FUEL TV (1080p)',
    category: 'Sports',
    resolution: '1080P',
    streamUrl:
      'https://amg01074-fueltv-fueltvau-samsungau-g09kq.amagi.tv/playlist/amg01074-fueltv-fueltvau-samsungau/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/111111/e50914?text=FUEL',
    country: 'Australia',
    tvgId: 'FUELTV.au',
    curated: true,
  },
  {
    id: 'espn-hd-us',
    name: 'ESPN HD',
    fullName: 'ESPN (United States) HD (720p)',
    category: 'Sports',
    resolution: '720P',
    streamUrl: 'http://85.237.89.160:9590/usa-s/ESPN-HD/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/d00000/white?text=ESPN',
    country: 'United States',
    tvgId: 'ESPN.us',
    requiresProxy: true,
    curated: true,
  },
  {
    id: 'espn-2-hd-us',
    name: 'ESPN 2 HD',
    fullName: 'ESPN 2 (United States) HD (720p)',
    category: 'Sports',
    resolution: '720P',
    streamUrl: 'http://85.237.89.160:9590/usa-s/ESPN-2-HD/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/d00000/white?text=ESPN2',
    country: 'United States',
    tvgId: 'ESPN2.us',
    requiresProxy: true,
    curated: true,
  },
  {
    id: 'fox-sports-1-hd',
    name: 'Fox Sports 1 HD',
    fullName: 'Fox Sports 1 (720p)',
    category: 'Sports',
    resolution: '720P',
    streamUrl: 'http://85.237.89.160:9590/usa-s/FOX-SPORTS-1/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/002868/white?text=FS1',
    country: 'United States',
    tvgId: 'FoxSports1.us',
    requiresProxy: true,
    curated: true,
  },

  // News
  {
    id: 'al-jazeera-english',
    name: 'Al Jazeera English HD',
    fullName: 'Al Jazeera English (1080p)',
    category: 'News',
    resolution: '1080P',
    streamUrl: 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/d48806/white?text=AJE',
    country: 'Global',
    tvgId: 'AlJazeera.qa',
    curated: true,
  },
  {
    id: 'africanews-english',
    name: 'Africanews English HD',
    fullName: 'Africanews English (720p)',
    category: 'News',
    resolution: '720P',
    streamUrl: 'https://cdn-euronews.akamaized.net/live/eds/africanews-en/25049/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/1b5e20/white?text=AFR',
    country: 'Global',
    tvgId: 'AfricanewsEnglish.fr',
    curated: true,
  },
  {
    id: 'cbs-news-live',
    name: 'CBS News Live HD',
    fullName: 'CBS News Live (720p)',
    category: 'News',
    resolution: '720P',
    streamUrl: 'https://lineup.cbsivideo.com/playout/8877a7d5-b094-4ac8-bc72-75a5fed68e5b/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/0d47a1/white?text=CBS',
    country: 'United States',
    tvgId: 'CBSNews.us',
    curated: true,
  },
  {
    id: 'abc-news-live',
    name: 'ABC News Live HD',
    fullName: 'ABC News Live (720p)',
    category: 'News',
    resolution: '720P',
    streamUrl: 'https://jmp2.uk/plu-6508be683a0d700008c534e4.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/1565c0/white?text=ABC',
    country: 'United States',
    tvgId: 'ABCNewsLive.us',
    curated: true,
  },
  {
    id: 'arirang-world',
    name: 'Arirang World HD',
    fullName: 'Arirang World (1080p)',
    category: 'News',
    resolution: '1080P',
    streamUrl: 'https://amdlive-ch02-ctnd-com.akamaized.net/arirang_2ch/smil:arirang_2ch.smil/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/006064/white?text=ARI',
    country: 'Global',
    tvgId: 'ArirangUN.kr',
    curated: true,
  },

  // Documentary & Learning / Science
  {
    id: 'history-hit-uk',
    name: 'History Hit HD',
    fullName: 'History Hit (1080p)',
    category: 'Documentary',
    resolution: '1080P',
    streamUrl: 'https://lds-timeline-rakuten.amagi.tv/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/4e342e/white?text=HIST',
    country: 'United Kingdom',
    tvgId: 'HistoryHit.uk',
    curated: true,
  },
  {
    id: 'inwild-nature',
    name: 'INWILD Nature HD',
    fullName: 'INWILD Wildlife & Nature (1080p)',
    category: 'Documentary',
    resolution: '1080P',
    streamUrl:
      'https://amg00861-terninternation-inwild-samsunguk-w5wic.amagi.tv/playlist/amg00861-terninternation-inwild-samsunguk/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/2e7d32/white?text=WILD',
    country: 'United Kingdom',
    tvgId: 'INWILD.uk',
    curated: true,
  },
  {
    id: 'autentic-history',
    name: 'Autentic History HD',
    fullName: 'Autentic History (1080p)',
    category: 'Documentary',
    resolution: '1080P',
    streamUrl:
      'https://9e754fa707344ccca6d84955c8fcaf36.mediatailor.us-east-1.amazonaws.com/v1/master/44f73ba4d03e9607dcd9bebdcb8494d86964f1d8/RlaxxTV-eu_AutenticHistory/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/37474f/white?text=AUTH',
    country: 'Germany',
    tvgId: 'AutenticHistory.de',
    curated: true,
  },
  {
    id: 'cgtn-documentary',
    name: 'CGTN Documentary HD',
    fullName: 'CGTN Documentary (1080p)',
    category: 'Documentary',
    resolution: '1080P',
    streamUrl: 'https://amg00405-rakutentv-cgtndocumentary-rakuten-0ql8j.amagi.tv/master.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/1a237e/white?text=DOCS',
    country: 'Global',
    tvgId: 'CGTNDocumentary.cn',
    curated: true,
  },
  {
    id: 'documentary-plus',
    name: 'Documentary+ HD',
    fullName: 'Documentary+ (1080p)',
    category: 'Documentary',
    resolution: '1080P',
    streamUrl:
      'https://ef79b15c8c7c46c7a9de9d33001dbd07.mediatailor.us-west-2.amazonaws.com/v1/master/ba62fe743df0fe93366eba3a257d792884136c7f/LINEAR-859-DOCUMENTARYPLUS-DOCUMENTARYPLUS/mt/documentaryplus/859/hls/master/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/263238/white?text=DOC+',
    country: 'United States',
    tvgId: 'DocumentaryPlus.us',
    curated: true,
  },
  {
    id: 'pluto-tv-science',
    name: 'Pluto TV Science',
    fullName: 'Pluto TV Science (720p)',
    category: 'Science',
    resolution: '720P',
    streamUrl: 'https://jmp2.uk/plu-563a970aa1a1f7fe7c9daad7.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/00838f/white?text=SCI',
    country: 'United States',
    tvgId: 'PlutoTVScience.us',
    curated: true,
  },

  // Movies & Entertainment
  {
    id: 'pluto-70s-cinema',
    name: '70s Cinema',
    fullName: '70s Cinema Movies (720p)',
    category: 'Movies',
    resolution: '720P',
    streamUrl: 'https://jmp2.uk/plu-5f4d878d3d19b30007d2e782.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/b71c1c/white?text=70s',
    country: 'United States',
    tvgId: '70sCinema.us',
    curated: true,
  },
  {
    id: '30a-classic-movies',
    name: '30A Classic Movies',
    fullName: '30A TV Classic Movies (720p)',
    category: 'Movies',
    resolution: '720P',
    streamUrl: 'https://30a-tv.com/feeds/pzaz/30atvmovies.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/880e4f/white?text=FILM',
    country: 'United States',
    tvgId: '30ATVClassicMovies.us',
    curated: true,
  },
  {
    id: 'people-are-awesome',
    name: 'People Are Awesome HD',
    fullName: 'People Are Awesome (1080p)',
    category: 'Entertainment',
    resolution: '1080P',
    streamUrl: 'https://mumbai-edge.smartplaytv.in/PeopleAreAwesome/index.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/e65100/white?text=PAA',
    country: 'United States',
    tvgId: 'PeopleAreAwesome.us',
    curated: true,
  },
  {
    id: 'mtv-pluto-tv',
    name: 'MTV Pluto TV',
    fullName: 'MTV Pluto TV (720p)',
    category: 'Entertainment',
    resolution: '720P',
    streamUrl: 'https://jmp2.uk/plu-5ca672f515a62078d2ec0ad2.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/6a1b9a/white?text=MTV',
    country: 'United States',
    tvgId: 'MTVPlutoTV.us',
    curated: true,
  },
  {
    id: 'bet-pluto-tv',
    name: 'BET Pluto TV',
    fullName: 'BET Pluto TV (720p)',
    category: 'Entertainment',
    resolution: '720P',
    streamUrl: 'https://jmp2.uk/plu-5ca670f6593a5d78f0e85aed.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/212121/ffeb3b?text=BET',
    country: 'United States',
    tvgId: 'BETPlutoTV.us',
    curated: true,
  },

  // Music
  {
    id: 'clubbing-tv-uk',
    name: 'Clubbing TV HD',
    fullName: 'Clubbing TV UK (720p)',
    category: 'Music',
    resolution: '720P',
    streamUrl: 'https://a-cdn.klowdtv.com/live3/clubbingtv_720p/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/7b1fa2/white?text=CLUB',
    country: 'United Kingdom',
    tvgId: 'ClubbingTV.uk',
    curated: true,
  },
  {
    id: 'kiss-kiss-tv',
    name: 'Kiss Kiss TV Music HD',
    fullName: 'Kiss Kiss TV (1080p)',
    category: 'Music',
    resolution: '1080P',
    streamUrl: 'https://58f12ffd2447a.streamlock.net/KKMulti/livestream/playlist.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/c2185b/white?text=KISS',
    country: 'Global',
    tvgId: 'KissKissTV.it',
    curated: true,
  },

  // Kids
  {
    id: 'babyfirst-hd',
    name: 'BabyFirst HD',
    fullName: 'BabyFirst TV (720p)',
    category: 'Kids',
    resolution: '720P',
    streamUrl: 'https://cdn.fast.jwp.services/v1/channel/1_jB6940Ei_TvhvIHDL/manifest.m3u8',
    fallbackUrls: [],
    logo: 'https://placehold.co/120x120/0288d1/white?text=KIDS',
    country: 'United States',
    tvgId: 'BabyFirst.us',
    curated: true,
  },
];

// In-Memory caches
let channelCache = [...CURATED_CHANNELS];
let channelsById = new Map(CURATED_CHANNELS.map((c) => [c.id, c]));
let healthCache = new Map(); // channelId -> { status: 'verified'|'offline'|'unknown', latencyMs, failCount, checkedAt, lastError }
let isInitialized = false;
let initPromise = null;
let backgroundProbeStarted = false;
let lastRefreshed = null;

// Seed curated channels as initially verified so cold starts display them immediately
for (const c of CURATED_CHANNELS) {
  healthCache.set(c.id, {
    status: 'verified',
    latencyMs: 1200,
    failCount: 0,
    checkedAt: Date.now(),
    lastError: null,
  });
}

// EPG schedule patterns by genre
const GENRE_SCHEDULE_TEMPLATES = {
  news: [
    { title: 'Global Morning Briefing', desc: 'Comprehensive coverage of top morning international headlines and markets.', durationMin: 60 },
    { title: 'World News Live', desc: 'Real-time breaking stories, field correspondents, and political analysis.', durationMin: 60 },
    { title: 'Financial Focus & Markets', desc: 'Global stock markets, economic trends, and business developments.', durationMin: 30 },
    { title: 'The Midday Report', desc: 'Key developments of the day, expert interviews, and global weather.', durationMin: 60 },
    { title: 'Investigative Insight', desc: 'Deep dive investigative journalism on world affairs and investigative reports.', durationMin: 60 },
    { title: 'Global Evening Panorama', desc: "Wrap-up of today's major international events and roundtable discussion.", durationMin: 60 },
    { title: 'Prime Time Spotlight', desc: 'Hard-hitting political interviews, debates, and breaking news updates.', durationMin: 60 },
    { title: 'Late Night International', desc: 'Global perspective from overseas newsrooms, sports recap, and forecasts.', durationMin: 60 },
  ],
  sports: [
    { title: 'SportsCenter Morning', desc: 'Recap of overnight fixtures, goals, rankings, and upcoming matches.', durationMin: 60 },
    { title: 'Championship Vault', desc: 'Classic matches, legendary moments, and iconic tournament highlights.', durationMin: 90 },
    { title: 'Live Matchday / Pre-Game', desc: 'Tactical analysis, lineup previews, and live pre-match interviews.', durationMin: 60 },
    { title: 'Prime Time Action Showcase', desc: 'Live sporting action, tournament coverage, and real-time score updates.', durationMin: 120 },
    { title: 'Post-Match Debrief & Highlights', desc: 'Post-game press conferences, pundit analysis, and key moment breakdowns.', durationMin: 60 },
    { title: 'Extreme & Motorsport Arena', desc: 'High-octane motorsport racing, action sports, and behind-the-scenes engineering.', durationMin: 60 },
  ],
  movies: [
    { title: 'Matinee Showcase', desc: 'Acclaimed classic drama and timeless cinematic storytelling.', durationMin: 120 },
    { title: 'Hollywood Hits', desc: 'Star-studded cinema blockbusters, award-winning scripts, and top thrillers.', durationMin: 120 },
    { title: 'Action & Adventure Premiere', desc: 'High-adrenaline feature film with explosive set pieces and iconic heroes.', durationMin: 120 },
    { title: 'Prime Time Feature Film', desc: "Tonight's centerpiece blockbuster movie presentation.", durationMin: 135 },
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
  education: [
    { title: 'Global Science & Discoveries', desc: 'Breakthroughs in astronomy, physics, medicine, and cutting-edge research.', durationMin: 60 },
    { title: 'Masterclass: History Uncovered', desc: 'Deep dive into pivotal historical events, civilizations, and archive footage.', durationMin: 60 },
    { title: 'Planet Earth Wonders', desc: 'Exploration of ocean ecosystems, wildlife behavior, and remote wilderness.', durationMin: 60 },
    { title: 'Curiosity Lab: How Things Work', desc: 'Everyday mechanics, architecture, engineering wonders, and innovations.', durationMin: 45 },
  ],
  learning: [
    { title: 'Global Science & Discoveries', desc: 'Breakthroughs in astronomy, physics, medicine, and cutting-edge research.', durationMin: 60 },
    { title: 'Masterclass: History Uncovered', desc: 'Deep dive into pivotal historical events, civilizations, and archive footage.', durationMin: 60 },
    { title: 'Planet Earth Wonders', desc: 'Exploration of ocean ecosystems, wildlife behavior, and remote wilderness.', durationMin: 60 },
    { title: 'Curiosity Lab: How Things Work', desc: 'Everyday mechanics, architecture, engineering wonders, and innovations.', durationMin: 45 },
  ],
};

// ==========================================
// SSRF Protection (IPv4 & IPv6)
// ==========================================

function isPrivateOrReservedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateOrReservedIpv6(ip) {
  const norm = ip.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  if (norm.startsWith('::ffff:')) {
    const mapped = norm.slice(7);
    if (net.isIPv4(mapped)) return isPrivateOrReservedIpv4(mapped);
  }
  if (/^(fc|fd)/i.test(norm)) return true; // ULA fc00::/7
  if (/^fe[89ab]/i.test(norm)) return true; // link-local fe80::/10
  if (norm.startsWith('ff')) return true; // multicast
  return false;
}

export function isPrivateIpAddress(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) return isPrivateOrReservedIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateOrReservedIpv6(ip);
  return true;
}

/**
 * Validates that a stream URL is safe to fetch server-side (blocks SSRF to metadata/private networks).
 */
export async function assertSafePublicUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw Object.assign(new Error('Invalid stream URL'), { statusCode: 400 });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Object.assign(new Error('Only HTTP/HTTPS stream URLs are permitted'), { statusCode: 403 });
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    throw Object.assign(new Error('Forbidden stream host'), { statusCode: 403 });
  }

  if (net.isIP(host)) {
    if (isPrivateIpAddress(host)) {
      throw Object.assign(new Error('Forbidden private/internal IP address'), { statusCode: 403 });
    }
    return parsed.href;
  }

  if (!options.skipDnsLookup) {
    try {
      const records = await dns.lookup(host, { all: true });
      if (!records || records.length === 0) {
        throw Object.assign(new Error('Stream host DNS resolution failed'), { statusCode: 502 });
      }
      for (const rec of records) {
        if (isPrivateIpAddress(rec.address)) {
          throw Object.assign(new Error('Stream host resolves to a forbidden private IP address'), { statusCode: 403 });
        }
      }
    } catch (err) {
      if (err.statusCode) throw err;
      throw Object.assign(new Error(`Unable to resolve stream host: ${err.message}`), { statusCode: 502 });
    }
  }

  return parsed.href;
}

// ==========================================
// Playlist Fetching, Parsing & Health Engine
// ==========================================

async function fetchWithRetry(url, retries = 2, timeoutMs = 12000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: timeoutMs,
        headers: { 'User-Agent': DEFAULT_USER_AGENT },
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Parses raw M3U text into structured channel objects.
 * Extracts #EXTVLCOPT / #EXTINF http-referrer & http-user-agent, filters [Geo-blocked],
 * [Not 24/7], .mpd (DASH), and known dead CDNs, and normalizes country metadata.
 */
export function parseM3u(content, fallbackCategory = 'Entertainment') {
  if (!content || typeof content !== 'string') return [];
  const lines = content.split('\n');
  const channels = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF:')) continue;

    const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
    const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/i);
    const groupMatch = line.match(/group-title="([^"]*)"/i);
    const extinfRefMatch = line.match(/http-referrer="([^"]*)"/i);
    const extinfUaMatch = line.match(/http-user-agent="([^"]*)"/i);

    const commaIdx = line.lastIndexOf(',');
    const rawTitle = commaIdx !== -1 ? line.substring(commaIdx + 1).trim() : 'Channel';

    // Filter out channels explicitly marked geo-blocked or not 24/7 in iptv-org
    if (/\[Geo-blocked\]|\[Not 24\/7\]/i.test(rawTitle)) {
      continue;
    }

    let cleanName = rawTitle.replace(/\[.*?\]/g, '').trim();
    const resMatch = cleanName.match(/\((1080p|720p|480p|360p|2160p|4k|HD|FHD)\)/i);
    const resolution = resMatch ? resMatch[1].toUpperCase() : '720P';
    cleanName = cleanName.replace(/\(.*?\)/g, '').trim();

    const tvgId = tvgIdMatch ? tvgIdMatch[1] : '';
    const logo = tvgLogoMatch ? tvgLogoMatch[1] : '';
    const category = groupMatch && groupMatch[1] ? groupMatch[1].split(';')[0].trim() : fallbackCategory;

    // Collect #EXTVLCOPT directives between #EXTINF and the stream URL
    let httpReferrer = extinfRefMatch ? extinfRefMatch[1].trim() : '';
    let httpUserAgent = extinfUaMatch ? extinfUaMatch[1].trim() : '';
    let streamUrl = '';

    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j].trim();
      if (!nextLine) continue;
      if (nextLine.startsWith('#EXTINF:')) {
        i = j - 1;
        break;
      }
      if (nextLine.startsWith('#EXTVLCOPT:')) {
        const refM = nextLine.match(/http-referrer=(.+)$/i);
        const uaM = nextLine.match(/http-user-agent=(.+)$/i);
        if (refM && !httpReferrer) httpReferrer = refM[1].trim();
        if (uaM && !httpUserAgent) httpUserAgent = uaM[1].trim();
        continue;
      }
      if (!nextLine.startsWith('#')) {
        streamUrl = nextLine;
        i = j;
        break;
      }
    }

    if (!cleanName || !streamUrl || (!streamUrl.startsWith('http://') && !streamUrl.startsWith('https://'))) {
      continue;
    }

    const lowerUrl = streamUrl.toLowerCase();
    const cleanPath = lowerUrl.split('?')[0];

    // Exclude MPEG-DASH (.mpd) and direct audio-only radio streams that hls.js cannot play
    if (
      cleanPath.endsWith('.mpd') ||
      cleanPath.endsWith('.mp3') ||
      cleanPath.endsWith('.aac') ||
      cleanPath.endsWith('.ogg') ||
      lowerUrl.includes('/dash/') ||
      lowerUrl.includes('manifest.mpd')
    ) {
      continue;
    }

    // Exclude known dead or permanently blocked CDN hosts
    if (BLOCKED_STREAM_HOSTS.some((bad) => lowerUrl.includes(bad))) {
      continue;
    }

    // Exclude adult channels from public Live TV
    const lowerCat = category.toLowerCase();
    const lowerName = cleanName.toLowerCase();
    if (lowerCat.includes('xxx') || lowerCat.includes('adult') || lowerName.includes('xxx') || lowerName.includes('porn')) {
      continue;
    }

    const baseTvg = tvgId.split('@')[0];
    const id = slugify(baseTvg || cleanName);

    let country = 'Global';
    if (/\.us(?:@|$)/i.test(tvgId)) country = 'United States';
    else if (/\.(uk|gb)(?:@|$)/i.test(tvgId)) country = 'United Kingdom';
    else if (/\.ca(?:@|$)/i.test(tvgId)) country = 'Canada';
    else if (/\.de(?:@|$)/i.test(tvgId)) country = 'Germany';
    else if (/\.au(?:@|$)/i.test(tvgId)) country = 'Australia';
    else if (/\.jp(?:@|$)/i.test(tvgId)) country = 'Japan';

    const safeLogo =
      logo && !logo.includes('paste.pics')
        ? logo
        : `https://placehold.co/120x120/1e1e1e/white?text=${encodeURIComponent(cleanName.slice(0, 4))}`;

    const headers = {};
    if (httpReferrer) headers.referer = httpReferrer;
    if (httpUserAgent) headers.userAgent = httpUserAgent;
    const hasCustomHeaders = Boolean(httpReferrer || httpUserAgent);
    const requiresProxy = streamUrl.startsWith('http://') || hasCustomHeaders;

    channels.push({
      id,
      name: cleanName,
      fullName: rawTitle,
      logo: safeLogo,
      category,
      resolution,
      streamUrl,
      fallbackUrls: [],
      tvgId,
      country,
      headers: hasCustomHeaders ? headers : undefined,
      requiresProxy,
    });
  }

  return channels;
}

/**
 * Probes a single channel URL (master + variant playlist reachability) from the current server region.
 */
export async function probeChannelHealth(channel, timeoutMs = 6500) {
  const urlsToTry = [channel.streamUrl, ...(channel.fallbackUrls || [])].filter(Boolean);
  const reqHeaders = {
    'User-Agent': channel.headers?.userAgent || DEFAULT_USER_AGENT,
    Accept: '*/*',
    ...(channel.headers?.referer ? { Referer: channel.headers.referer } : {}),
  };

  let lastReason = 'UNREACHABLE';
  for (const candidateUrl of urlsToTry) {
    const start = Date.now();
    try {
      const res = await axios.get(candidateUrl, {
        timeout: timeoutMs,
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: () => true,
        headers: reqHeaders,
      });

      if (res.status < 200 || res.status >= 300) {
        lastReason = `HTTP_${res.status}`;
        continue;
      }

      const buf = Buffer.from(res.data);
      const text = buf.toString('utf8');
      if (!text.includes('#EXTM3U')) {
        lastReason = 'NOT_M3U8';
        continue;
      }

      const finalUrl = res.request?.res?.responseUrl || candidateUrl;
      const entries = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

      if (entries.length === 0) {
        lastReason = 'EMPTY_PLAYLIST';
        continue;
      }

      const childUrl = new URL(entries[0], finalUrl).href;
      const childRes = await axios.get(childUrl, {
        timeout: Math.min(5500, timeoutMs),
        responseType: 'arraybuffer',
        maxRedirects: 5,
        validateStatus: () => true,
        headers: reqHeaders,
      });

      if (childRes.status < 200 || childRes.status >= 300) {
        lastReason = `CHILD_HTTP_${childRes.status}`;
        continue;
      }

      const latencyMs = Date.now() - start;
      // If a fallback URL succeeded while primary failed, promote the working URL
      if (candidateUrl !== channel.streamUrl) {
        channel.fallbackUrls = [
          channel.streamUrl,
          ...(channel.fallbackUrls || []).filter((u) => u !== candidateUrl),
        ];
        channel.streamUrl = candidateUrl;
      }

      const state = {
        status: 'verified',
        latencyMs,
        failCount: 0,
        checkedAt: Date.now(),
        lastError: null,
      };
      healthCache.set(channel.id, state);
      return state;
    } catch (err) {
      lastReason = err.code || String(err.message || 'ERROR').slice(0, 32);
    }
  }

  const prev = healthCache.get(channel.id);
  const state = {
    status: 'offline',
    latencyMs: 0,
    failCount: (prev?.failCount || 0) + 1,
    checkedAt: Date.now(),
    lastError: lastReason,
  };
  healthCache.set(channel.id, state);
  return state;
}

/**
 * Updates runtime channel health when the proxy or player encounters live successes or failures.
 */
export function recordChannelRuntimeHealth(channelId, ok, reason = null) {
  if (!channelId) return;
  const prev = healthCache.get(channelId) || { status: 'unknown', latencyMs: 0, failCount: 0, checkedAt: 0 };
  if (ok) {
    healthCache.set(channelId, {
      status: 'verified',
      latencyMs: prev.latencyMs || 1000,
      failCount: 0,
      checkedAt: Date.now(),
      lastError: null,
    });
    return;
  }

  const nextFails = (prev.failCount || 0) + 1;
  const tripped = nextFails >= 2 || reason === 'client-reported-offline';
  const next = {
    status: tripped ? 'offline' : prev.status,
    latencyMs: prev.latencyMs || 0,
    failCount: nextFails,
    checkedAt: Date.now(),
    lastError: reason || 'proxy-error',
  };
  healthCache.set(channelId, next);

  if (tripped) {
    iptvHealthDB
      .upsertMany([
        {
          channel_id: channelId,
          status: 'offline',
          latency_ms: 0,
          fail_count: nextFails,
          last_error: next.lastError,
        },
      ])
      .catch(() => {});
  }
}

/**
 * Background reachability pass tailored to the running instance region (e.g. europe-west4).
 * Probes curated channels + balanced top candidates across all categories & 6 countries,
 * persisting results to MongoDB (6h TTL) so cold starts benefit immediately.
 */
async function runBackgroundReachabilityProbe() {
  if (backgroundProbeStarted) return;
  backgroundProbeStarted = true;

  try {
    // Load any warm 6h TTL health records from MongoDB first
    const persisted = await iptvHealthDB.loadAll();
    let loadedVerified = 0;
    for (const rec of persisted) {
      if (!rec?.channel_id) continue;
      healthCache.set(rec.channel_id, {
        status: rec.status || 'unknown',
        latencyMs: rec.latency_ms || 0,
        failCount: rec.fail_count || 0,
        checkedAt: rec.checked_at ? new Date(rec.checked_at).getTime() : Date.now(),
        lastError: rec.last_error || null,
      });
      if (rec.status === 'verified') loadedVerified++;
    }

    // Build focused probe queue: all curated + top 12 HTTPS candidates per category & country
    const queueMap = new Map();
    for (const c of CURATED_CHANNELS) {
      queueMap.set(c.id, channelsById.get(c.id) || c);
    }

    const addTopCandidates = (subset, maxCount) => {
      let added = 0;
      for (const ch of subset) {
        if (added >= maxCount) break;
        if (queueMap.has(ch.id)) continue;
        const h = healthCache.get(ch.id);
        // Skip channels already probed in the last 3 hours
        if (h && h.checkedAt && Date.now() - h.checkedAt < 3 * 60 * 60 * 1000 && !ch.curated) {
          continue;
        }
        queueMap.set(ch.id, ch);
        added++;
      }
    };

    const httpsChannels = channelCache.filter((c) => c.streamUrl.startsWith('https://'));
    for (const cat of CATEGORY_PLAYLISTS) {
      const catMatches = httpsChannels.filter((c) => (c.category || '').toLowerCase().includes(cat.id === 'learning' ? 'doc' : cat.id));
      addTopCandidates(catMatches, 10);
    }
    for (const country of COUNTRY_PLAYLISTS.filter((c) => c.id !== 'global')) {
      const cMatches = httpsChannels.filter((c) => matchesCountryFilter(c, country.id));
      addTopCandidates(cMatches, 10);
    }

    const queue = Array.from(queueMap.values()).slice(0, 160);
    if (queue.length === 0) return;

    console.log(`[Live TV Health] Probing ${queue.length} priority channels for instance reachability (loaded ${loadedVerified} cached)...`);
    const dbRecords = [];
    let verifiedCount = 0;
    let offlineCount = 0;

    await runWithConcurrency(queue, 8, async (ch) => {
      const st = await probeChannelHealth(ch, 6500);
      if (st.status === 'verified') verifiedCount++;
      else offlineCount++;
      dbRecords.push({
        channel_id: ch.id,
        status: st.status,
        latency_ms: st.latencyMs,
        fail_count: st.failCount,
        last_error: st.lastError,
        stream_url: ch.streamUrl,
      });
    });

    await iptvHealthDB.upsertMany(dbRecords);
    console.log(`[Live TV Health] Probe complete: ${verifiedCount} verified live, ${offlineCount} filtered offline.`);
  } catch (err) {
    console.warn('[Live TV Health Probe Warning]:', err.message);
  }
}

/**
 * Initializes and caches IPTV channels from iptv-org playlists with bounded concurrency & retries.
 */
export async function initIptvService(options = {}) {
  if (isInitialized && channelCache.length > CURATED_CHANNELS.length) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log('[Live TV] Fetching public channel playlists from iptv-org (6 countries / 3 continents)...');

      // 1. Fetch category playlists with bounded concurrency (4) + retry to prevent ECONNRESET drops
      const categoryResults = await runWithConcurrency(CATEGORY_PLAYLISTS, 4, async (cat) => {
        try {
          const data = await fetchWithRetry(cat.url, 2, 12000);
          return { cat, channels: parseM3u(data, cat.name) };
        } catch (err) {
          console.warn(`[Live TV] Failed to fetch category ${cat.name}:`, err.message);
          return { cat, channels: [] };
        }
      });

      // 2. Fetch 6 country playlists (US, CA, UK, DE, AU, JP) with bounded concurrency + retry
      const countryTargets = COUNTRY_PLAYLISTS.filter((c) => c.id !== 'global');
      const countryResults = await runWithConcurrency(countryTargets, 3, async (c) => {
        try {
          const data = await fetchWithRetry(c.url, 2, 12000);
          return { country: c, channels: parseM3u(data, 'General') };
        } catch (err) {
          console.warn(`[Live TV] Failed to fetch country ${c.name}:`, err.message);
          return { country: c, channels: [] };
        }
      });

      const combinedMap = new Map();

      const mergeChannel = (ch, overrides = {}) => {
        const merged = { ...ch, ...overrides };
        if (!combinedMap.has(merged.id)) {
          combinedMap.set(merged.id, merged);
        } else {
          const existing = combinedMap.get(merged.id);
          if (overrides.country && existing.country === 'Global') {
            existing.country = overrides.country;
          }
          // Retain unique alternate stream URLs as failover mirrors
          if (
            merged.streamUrl !== existing.streamUrl &&
            !(existing.fallbackUrls || []).includes(merged.streamUrl) &&
            (existing.fallbackUrls || []).length < 3
          ) {
            existing.fallbackUrls = [...(existing.fallbackUrls || []), merged.streamUrl];
          }
        }
      };

      for (const { cat, channels } of categoryResults) {
        for (const ch of channels) {
          mergeChannel(ch, { category: cat.name });
        }
      }

      for (const { country, channels } of countryResults) {
        for (const ch of channels) {
          mergeChannel(ch, { country: country.name });
        }
      }

      // Inject curated channels first, attaching matching iptv-org streams as fallbacks
      const finalMap = new Map();
      for (const curated of CURATED_CHANNELS) {
        finalMap.set(curated.id, { ...curated, fallbackUrls: [...(curated.fallbackUrls || [])] });
      }

      for (const [id, ch] of combinedMap.entries()) {
        const lowerName = ch.name.toLowerCase();
        if (lowerName.includes('bein') && lowerName.includes('xtra')) {
          continue; // Already using verified multi-CDN curated beIN XTRA entries
        }
        if (finalMap.has(id)) {
          const existing = finalMap.get(id);
          if (
            ch.streamUrl !== existing.streamUrl &&
            !existing.fallbackUrls.includes(ch.streamUrl) &&
            existing.fallbackUrls.length < 3
          ) {
            existing.fallbackUrls.push(ch.streamUrl);
          }
        } else {
          finalMap.set(id, ch);
        }
      }

      channelCache = Array.from(finalMap.values());
      channelsById.clear();
      channelCache.forEach((c) => channelsById.set(c.id, c));

      lastRefreshed = new Date();
      isInitialized = channelCache.length > CURATED_CHANNELS.length;
      console.log(`[Live TV] Loaded ${channelCache.length} clean HLS channels (filtered geo-blocked, not-24/7, DASH, & dead CDNs).`);

      // Launch non-blocking reachability probe unless explicitly disabled (e.g. unit test fast mode)
      if (!options.skipBackgroundProbe && process.env.NODE_ENV !== 'test') {
        runBackgroundReachabilityProbe().catch(() => {});
      }
    } catch (err) {
      console.error('[Live TV Init Error]:', err.message);
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Computes deterministic real-time EPG program schedule for a channel.
 */
export function getChannelEpg(channel, targetDate = new Date()) {
  const catKey = (channel.category || 'entertainment').toLowerCase();
  const templates = GENRE_SCHEDULE_TEMPLATES[catKey] || GENRE_SCHEDULE_TEMPLATES.entertainment;

  const dayStr = targetDate.toISOString().slice(0, 10);
  const seedString = `${channel.id}-${dayStr}`;
  let seedNum = 0;
  for (let k = 0; k < seedString.length; k++) {
    seedNum = (seedNum << 5) - seedNum + seedString.charCodeAt(k);
    seedNum |= 0;
  }
  const seedOffset = Math.abs(seedNum) % templates.length;

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

  const nowMs = targetDate.getTime();
  let currentProgram = schedule.find((p) => nowMs >= p.startTimestamp && nowMs < p.stopTimestamp);
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
      fallbackUrls: channel.fallbackUrls || [],
      requiresProxy: Boolean(channel.requiresProxy),
    },
    currentProgram: currentProgram
      ? {
          ...currentProgram,
          progressPercent,
          remainingMinutes,
        }
      : null,
    nextProgram,
    schedule,
  };
}

function matchesCountryFilter(channel, countryQuery) {
  if (!countryQuery || countryQuery === 'all') return true;
  const q = countryQuery.toLowerCase().trim();
  const chCountry = (channel.country || 'Global').toLowerCase();

  if (q === 'us' || q === 'united states') return chCountry === 'united states';
  if (q === 'ca' || q === 'canada') return chCountry === 'canada';
  if (q === 'uk' || q === 'gb' || q === 'united kingdom') return chCountry === 'united kingdom';
  if (q === 'de' || q === 'germany') return chCountry === 'germany';
  if (q === 'au' || q === 'australia') return chCountry === 'australia';
  if (q === 'jp' || q === 'japan') return chCountry === 'japan';
  if (q === 'global' || q.includes('global') || q === 'eng') return chCountry === 'global';
  return chCountry.includes(q);
}

function getEffectiveHealthStatus(channel) {
  const rec = healthCache.get(channel.id);
  if (!rec) return { status: 'unknown', latencyMs: 99999 };
  // Allow offline circuit-broken channels to be re-tried after 30 minutes
  if (rec.status === 'offline' && rec.checkedAt && Date.now() - rec.checkedAt > 30 * 60 * 1000) {
    return { status: 'unknown', latencyMs: 99999 };
  }
  return rec;
}

function channelRankScore(ch) {
  const h = getEffectiveHealthStatus(ch);
  const isHttps = ch.streamUrl.startsWith('https://');
  if (ch.curated && h.status === 'verified') return 0 + (h.latencyMs || 0) / 100000;
  if (h.status === 'verified') return 1 + (h.latencyMs || 0) / 100000;
  if (h.status === 'unknown' && isHttps) return 2;
  if (h.status === 'unknown') return 3;
  return 9; // offline
}

/**
 * Retrieves paginated channels ranked Verified-First with enriched real-time EPG data.
 */
export async function getChannels(options = {}) {
  if (!isInitialized) {
    await initIptvService();
  }

  const {
    category,
    country,
    search,
    verifiedOnly = false,
    includeOffline = false,
    limit = 60,
    offset = 0,
  } = options;

  let list = channelCache.filter((c) => {
    const h = getEffectiveHealthStatus(c);
    if (!includeOffline && h.status === 'offline') return false;
    if (verifiedOnly && h.status !== 'verified') return false;
    return true;
  });

  if (category && category !== 'all') {
    const qCat = category.toLowerCase().trim();
    if (qCat === 'learning' || qCat === 'education' || qCat === 'docs' || qCat.includes('learning')) {
      list = list.filter((c) => {
        const cat = (c.category || '').toLowerCase();
        return cat.includes('learning') || cat.includes('education') || cat.includes('science') || cat.includes('documentary');
      });
    } else if (qCat === 'sports' || qCat === 'sport') {
      list = list.filter((c) => (c.category || '').toLowerCase().includes('sport'));
    } else if (qCat === 'movies' || qCat === 'movie') {
      list = list.filter((c) => (c.category || '').toLowerCase().includes('movie'));
    } else if (qCat === 'series' || qCat === 'tv') {
      list = list.filter((c) => (c.category || '').toLowerCase().includes('series'));
    } else {
      list = list.filter((c) => (c.category || '').toLowerCase().includes(qCat));
    }
    list.sort((a, b) => channelRankScore(a) - channelRankScore(b) || a.name.localeCompare(b.name));
  } else if (!search && (!country || country === 'all')) {
    // Diverse showcase across Sports, News, Documentary/Learning, Movies, Entertainment, Kids — verified first!
    const sortBucket = (arr) => arr.sort((a, b) => channelRankScore(a) - channelRankScore(b) || a.name.localeCompare(b.name));
    const sports = sortBucket(list.filter((c) => (c.category || '').toLowerCase().includes('sport')));
    const news = sortBucket(list.filter((c) => (c.category || '').toLowerCase().includes('news')));
    const docs = sortBucket(
      list.filter((c) => {
        const cat = (c.category || '').toLowerCase();
        return cat.includes('education') || cat.includes('learning') || cat.includes('science') || cat.includes('documentary');
      })
    );
    const entertainment = sortBucket(list.filter((c) => (c.category || '').toLowerCase().includes('entertainment')));
    const moviesSeries = sortBucket(
      list.filter((c) => {
        const cat = (c.category || '').toLowerCase();
        return cat.includes('movie') || cat.includes('series');
      })
    );

    const interleaved = [];
    const maxLen = Math.max(sports.length, news.length, docs.length, entertainment.length, moviesSeries.length);
    for (let i = 0; i < maxLen; i++) {
      if (sports[i]) interleaved.push(sports[i]);
      if (news[i]) interleaved.push(news[i]);
      if (docs[i]) interleaved.push(docs[i]);
      if (entertainment[i]) interleaved.push(entertainment[i]);
      if (moviesSeries[i]) interleaved.push(moviesSeries[i]);
    }

    const includedIds = new Set(interleaved.map((c) => c.id));
    const remainder = sortBucket(list.filter((c) => !includedIds.has(c.id)));
    list = [...interleaved, ...remainder];
  } else {
    list.sort((a, b) => channelRankScore(a) - channelRankScore(b) || a.name.localeCompare(b.name));
  }

  if (country && country !== 'all') {
    list = list.filter((c) => matchesCountryFilter(c, country));
  }

  if (search) {
    const q = search.toLowerCase();
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.category || '').toLowerCase().includes(q) ||
        (c.country || '').toLowerCase().includes(q)
    );
  }

  const total = list.length;
  const paged = list.slice(offset, offset + limit);
  const now = new Date();

  const items = paged.map((c) => {
    const epg = getChannelEpg(c, now);
    const h = getEffectiveHealthStatus(c);
    // Do not expose internal upstream header secrets if unnecessary; client only needs requiresProxy flag
    const { headers, ...publicChannel } = c;
    return {
      ...publicChannel,
      healthStatus: h.status,
      latencyMs: h.status === 'verified' ? h.latencyMs : null,
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
 * Returns all available categories and 6 countries / 3 continents with active (non-offline) channel counts.
 */
export async function getCategories() {
  if (!isInitialized) {
    await initIptvService();
  }

  const activeChannels = channelCache.filter((c) => getEffectiveHealthStatus(c).status !== 'offline');
  const verifiedCount = activeChannels.filter((c) => getEffectiveHealthStatus(c).status === 'verified').length;

  const catCounts = new Map();
  activeChannels.forEach((c) => {
    const cat = c.category || 'General';
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
  });

  const categories = CATEGORY_PLAYLISTS.map((cp) => {
    let count = catCounts.get(cp.name) || 0;
    if (cp.id === 'learning') {
      count =
        (catCounts.get('Learning & Docs') || 0) +
        (catCounts.get('Education') || 0) +
        (catCounts.get('Science') || 0) +
        (catCounts.get('Documentary') || 0);
    } else if (cp.id === 'sports') {
      count = catCounts.get('Sports') || catCounts.get('Sport') || 0;
    }
    return {
      id: cp.id,
      name: cp.name,
      icon: cp.icon,
      count,
    };
  });

  const countries = COUNTRY_PLAYLISTS.map((cp) => ({
    id: cp.id,
    name: cp.name,
    continent: cp.continent,
    flag: cp.flag,
    count: activeChannels.filter((c) => matchesCountryFilter(c, cp.id)).length,
  }));

  return {
    categories,
    countries,
    totalChannels: activeChannels.length,
    verifiedChannels: verifiedCount,
    lastRefreshed,
  };
}

export async function getChannelSchedule(channelId) {
  if (!isInitialized) {
    await initIptvService();
  }

  const channel = channelsById.get(channelId);
  if (!channel) return null;

  return getChannelEpg(channel, new Date());
}

/**
 * Rewrites relative and absolute URIs within M3U8 playlists against the post-redirect baseUrl
 * so every sub-playlist, encryption key, init map, and media segment routes cleanly through Kodimi's proxy
 * while preserving channelId (for server-side Referer/UA injection) and auth token.
 */
export function rewriteM3u8(manifestText, baseUrl, options = {}) {
  const { channelId = '', token = '' } = options;

  const buildProxyPath = (resolvedUrl) => {
    let out = `/api/iptv/proxy?url=${encodeURIComponent(resolvedUrl)}`;
    if (channelId) out += `&channelId=${encodeURIComponent(channelId)}`;
    if (token) out += `&token=${encodeURIComponent(token)}`;
    return out;
  };

  const lines = manifestText.split('\n');
  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Rewrite URI="..." attributes inside tags (#EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-MAP, #EXT-X-I-FRAME-STREAM-INF)
    if (trimmed.startsWith('#')) {
      return line.replace(/URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/g, (match, dq, sq, bare) => {
        const uri = dq || sq || bare;
        if (!uri) return match;
        try {
          const resolved = new URL(uri, baseUrl).href;
          return `URI="${buildProxyPath(resolved)}"`;
        } catch {
          return match;
        }
      });
    }

    // Non-comment lines are variant playlists or media segments
    try {
      const resolved = new URL(trimmed, baseUrl).href;
      return buildProxyPath(resolved);
    } catch {
      return line;
    }
  });

  return rewritten.join('\n');
}

function getUpstreamHeadersForChannel(channelId, req) {
  const ch = channelId ? channelsById.get(channelId) : null;
  const headers = {
    'User-Agent': ch?.headers?.userAgent || DEFAULT_USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (ch?.headers?.referer) {
    headers.Referer = ch.headers.referer;
    try {
      headers.Origin = new URL(ch.headers.referer).origin;
    } catch (_) {}
  }
  if (req && req.headers && req.headers.range) {
    headers.Range = req.headers.range;
  }
  return headers;
}

/**
 * Proxies live HLS streams and segments with SSRF validation, post-redirect base URL rewriting,
 * per-channel Referer/User-Agent injection, clean abort-on-disconnect, and circuit breaker tracking.
 */
export async function proxyHlsStream(streamUrl, req, res, options = {}) {
  const { channelId = '', token = '' } = options;
  const controller = new AbortController();
  const onClientClose = () => {
    try {
      controller.abort();
    } catch (_) {}
  };
  if (res && typeof res.on === 'function') {
    res.on('close', onClientClose);
  }

  try {
    const safeUrl = await assertSafePublicUrl(streamUrl);
    const cleanPath = safeUrl.split('?')[0].toLowerCase();
    const isBinarySegment =
      cleanPath.endsWith('.ts') ||
      cleanPath.endsWith('.tbin') ||
      cleanPath.endsWith('.m4s') ||
      cleanPath.endsWith('.mp4') ||
      cleanPath.endsWith('.key') ||
      cleanPath.endsWith('.aac') ||
      cleanPath.endsWith('.vtt') ||
      cleanPath.endsWith('.cmfv') ||
      cleanPath.endsWith('.cmfa');

    const headers = getUpstreamHeadersForChannel(channelId, req);

    if (isBinarySegment) {
      const response = await axios({
        method: 'GET',
        url: safeUrl,
        responseType: 'stream',
        timeout: 15000,
        maxRedirects: 5,
        signal: controller.signal,
        headers,
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      let contentType = response.headers['content-type'] || 'application/octet-stream';
      if (cleanPath.endsWith('.ts') || cleanPath.endsWith('.tbin')) {
        contentType = 'video/mp2t';
      }
      res.setHeader('Content-Type', contentType);
      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }
      if (response.headers['content-range']) {
        res.setHeader('Content-Range', response.headers['content-range']);
      }
      res.status(response.status);

      response.data.on('error', (streamErr) => {
        if (!controller.signal.aborted) {
          console.warn(`[IPTV Segment Stream Error]: ${streamErr.message}`);
        }
        try {
          res.end();
        } catch (_) {}
      });

      return response.data.pipe(res);
    }

    // Fetch manifest or extensionless chunk safely into buffer
    const response = await axios({
      method: 'GET',
      url: safeUrl,
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      signal: controller.signal,
      headers,
    });

    const finalUrl = response.request?.res?.responseUrl || safeUrl;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    const buf = Buffer.from(response.data);
    const textPrefix = buf.slice(0, 128).toString('utf-8');

    if (textPrefix.includes('#EXTM3U')) {
      if (channelId) recordChannelRuntimeHealth(channelId, true);
      const manifestText = buf.toString('utf-8');
      // CRITICAL: Resolve relative sub-playlists & segments against post-redirect finalUrl
      const rewritten = rewriteM3u8(manifestText, finalUrl, { channelId, token });
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(rewritten);
    }

    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    return res.send(buf);
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err.statusCode === 400 || err.statusCode === 403) {
      if (!res.headersSent) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      return;
    }
    if (channelId) {
      recordChannelRuntimeHealth(channelId, false, err.code || err.response?.status || 'proxy-error');
    }
    console.error(`[IPTV Proxy Error for ${streamUrl}]:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Stream unreachable or offline' });
    }
  } finally {
    if (res && typeof res.off === 'function') {
      res.off('close', onClientClose);
    }
  }
}

/**
 * On-demand real-time live stream downscaling / codec compatibility transcode (720p, 480p, 360p).
 * SSRF-protected, forwards per-channel Referer/UA headers, and immediately kills FFmpeg on disconnect.
 */
export async function transcodeLiveStream(streamUrl, quality = '480p', req, res, options = {}) {
  const { channelId = '' } = options;

  let safeUrl;
  try {
    safeUrl = await assertSafePublicUrl(streamUrl);
  } catch (err) {
    if (!res.headersSent) {
      return res.status(err.statusCode || 403).json({ error: err.message });
    }
    return;
  }

  const PROFILES = {
    '720p': { height: 720, videoBitrate: '1500k', audioBitrate: '128k' },
    '480p': { height: 480, videoBitrate: '800k', audioBitrate: '96k' },
    '360p': { height: 360, videoBitrate: '450k', audioBitrate: '64k' },
  };

  const profile = PROFILES[quality] || PROFILES['480p'];
  const ch = channelId ? channelsById.get(channelId) : null;
  const ua = ch?.headers?.userAgent || DEFAULT_USER_AGENT;
  let ffHeaders = `User-Agent: ${ua}\r\n`;
  if (ch?.headers?.referer) {
    ffHeaders += `Referer: ${ch.headers.referer}\r\n`;
  }

  const command = ffmpeg(safeUrl)
    .inputOptions([
      '-headers', ffHeaders,
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-probesize', '1500000',
      '-analyzeduration', '1500000',
      '-fflags', '+nobuffer',
    ])
    .format('mp4')
    .outputOptions([
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-vf', `scale=-2:${profile.height}`,
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-g', '48',
      '-keyint_min', '24',
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-b:v', profile.videoBitrate,
      '-c:a', 'aac',
      '-b:a', profile.audioBitrate,
      '-ar', '48000',
      '-ac', '2',
      '-threads', '1',
      '-max_muxing_queue_size', '1024',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
    ]);

  command.on('start', () => {
    console.log(`[Live Transcode Started (${quality})]: ${safeUrl}`);
  });

  command.on('stderr', (line) => {
    if (line.includes('Error') || line.includes('Opening') || line.includes('Output')) {
      console.log('[FFMPEG Stderr]:', line);
    }
  });

  command.on('error', (err) => {
    if (
      err.message &&
      (err.message.includes('SIGKILL') ||
        err.message.includes('Output stream closed') ||
        err.message.includes('pipe:1: End of file'))
    ) {
      return;
    }
    console.warn(`[Live Transcode Error]: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Live stream offline or unreachable for transcoding' });
    } else {
      res.end();
    }
  });

  const killLiveTranscode = () => {
    try {
      command.kill('SIGKILL');
      console.log('[Live Transcode Terminated]: Client socket closed.');
    } catch (_) {}
  };
  res.on('close', killLiveTranscode);
  res.on('error', killLiveTranscode);

  const ffStream = command.pipe();
  let headerWritten = false;
  ffStream.on('data', (chunk) => {
    if (!headerWritten && !res.headersSent) {
      headerWritten = true;
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
    }
    res.write(chunk);
  });

  ffStream.on('end', () => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Live stream produced no output' });
    } else {
      res.end();
    }
  });
}

function slugify(text) {
  return (
    (text || '')
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]+/g, '')
      .replace(/\-\-+/g, '-')
      .slice(0, 60) || `ch-${crypto.randomBytes(4).toString('hex')}`
  );
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
  CURATED_CHANNELS,
  initIptvService,
  parseM3u,
  rewriteM3u8,
  assertSafePublicUrl,
  isPrivateIpAddress,
  probeChannelHealth,
  recordChannelRuntimeHealth,
  getChannels,
  getCategories,
  getChannelSchedule,
  proxyHlsStream,
  transcodeLiveStream,
};
