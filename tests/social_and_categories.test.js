import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSocialPlatform,
  detectPlaylistIntent,
  detectSocialAdultContent,
  selectDirectProgressiveFormat,
  selectLargeSplitHttpsFormats,
  normalizePlaylistEntries,
  buildSocialMediaMetadata,
  resolveYtDlpRunner,
  sanitizeFilenameSegment,
} from '../server/services/socialDownloader.js';
import { applyCategoryOverride } from '../server/services/aiTagger.js';
import { mediaDB } from '../server/db/database.js';
import {
  collapseGroupedMedia,
  renderSeriesCard,
  renderSeriesModalContent,
} from '../public/js/components.js';
import { resolveNextSeriesEpisode } from '../public/js/player.js';

test('detectSocialPlatform accurately identifies all 6 supported social networks and rejects non-social URLs', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://youtube.com/shorts/abc12345', 'youtube'],
    ['https://www.instagram.com/reel/Cx12345678/', 'instagram'],
    ['https://twitter.com/NASA/status/1234567890', 'twitter'],
    ['https://x.com/GoogleDeepMind/status/1234567890', 'twitter'],
    ['https://www.reddit.com/r/videos/comments/abc123/cool_clip/', 'reddit'],
    ['https://v.redd.it/abcdef123456', 'reddit'],
    ['https://www.linkedin.com/posts/username_video-activity-123456', 'linkedin'],
    ['https://www.facebook.com/watch/?v=1234567890', 'facebook'],
    ['https://fb.watch/abc12345/', 'facebook'],
  ];

  for (const [url, expected] of cases) {
    const detected = detectSocialPlatform(url);
    assert.equal(detected?.id, expected, `Expected ${url} to detect as ${expected}, got ${detected?.id}`);
  }

  // Non-social / direct video / malicious URLs must return null
  assert.equal(detectSocialPlatform('https://example.com/movie.mp4'), null);
  assert.equal(detectSocialPlatform('magnet:?xt=urn:btih:1234567890abcdef'), null);
  assert.equal(detectSocialPlatform('file:///etc/passwd'), null);
  assert.equal(detectSocialPlatform('not-a-url'), null);
  assert.equal(detectSocialPlatform('https://notyoutube.com/watch?v=123'), null);
});

test('resolveYtDlpRunner detects local yt-dlp and sanitizeFilenameSegment strips unsafe path characters', () => {
  const runner = resolveYtDlpRunner();
  assert.ok(runner && runner.version, 'Expected yt-dlp runner to be available locally');
  assert.equal(sanitizeFilenameSegment('My: Cool/Video? <2026> "clip"\n'), 'My CoolVideo 2026 clip');
  assert.equal(sanitizeFilenameSegment('   ', 'fallback'), 'fallback');
});

test('Documentary and Others media categories work across applyCategoryOverride, mediaDB.getAll, and mediaDB.updateCategory', async () => {
  const docId = 'test-cat-doc-1';
  const docByGenreId = 'test-cat-doc-genre-2';
  const othersId = 'test-cat-others-3';

  try {
    // 1. applyCategoryOverride enforces user-selected documentary & others tags
    const overriddenDoc = applyCategoryOverride(
      { title: 'Planet Earth Special', type: 'movie', genres: ['Nature'], tags: [] },
      'documentary'
    );
    assert.equal(overriddenDoc.type, 'documentary');
    assert.ok(overriddenDoc.genres.includes('Documentary'));
    assert.ok(overriddenDoc.tags.some((t) => t.toLowerCase() === 'documentary'));

    const overriddenOthers = applyCategoryOverride(
      { title: 'Conference Keynote', type: 'movie', genres: ['Drama'], tags: [] },
      'others'
    );
    assert.equal(overriddenOthers.type, 'others');
    assert.ok(overriddenOthers.tags.some((t) => t.toLowerCase() === 'others'));

    // 2. mediaDB.getAll filters documentary (both explicit type & Documentary genre) and others cleanly
    await mediaDB.upsert({
      id: docId,
      type: 'documentary',
      title: 'Test Deep Sea Documentary',
      genres: ['Documentary', 'Nature'],
      tags: ['documentary'],
      filename: 'Deep.Sea.Doc.mp4',
      gcs_path: 'Docs/Deep.Sea.Doc.mp4',
    });
    await mediaDB.upsert({
      id: docByGenreId,
      type: 'movie',
      title: 'Test Genre Tagged Documentary',
      genres: ['Documentary'],
      tags: [],
      filename: 'Genre.Doc.mp4',
      gcs_path: 'Movies/Genre.Doc.mp4',
    });
    await mediaDB.upsert({
      id: othersId,
      type: 'others',
      title: 'Test Social Media Video',
      genres: ['Social', 'YouTube'],
      tags: ['others', 'youtube'],
      filename: 'Social.Clip.mp4',
      gcs_path: 'Social/YouTube/Social.Clip.mp4',
    });

    const docs = mediaDB.getAll({ type: 'documentary' }).map((m) => m.id);
    assert.ok(docs.includes(docId), 'Explicit documentary type should appear in documentary filter');
    assert.ok(docs.includes(docByGenreId), 'Documentary-genre movie should appear in documentary filter');
    assert.ok(!docs.includes(othersId), 'Others item should not appear in documentary filter');

    const others = mediaDB.getAll({ type: 'others' }).map((m) => m.id);
    assert.ok(others.includes(othersId), 'Others item should appear in others filter');
    assert.ok(!others.includes(docId), 'Documentary should not appear in others filter');

    // 3. mediaDB.updateCategory re-tags an item cleanly
    const updated = await mediaDB.updateCategory(othersId, 'documentary');
    assert.equal(updated.type, 'documentary');
    assert.ok(updated.genres.includes('Documentary'));
    assert.ok(updated.tags.some((t) => t.toLowerCase() === 'documentary'));

    const docsAfter = mediaDB.getAll({ type: 'documentary' }).map((m) => m.id);
    assert.ok(docsAfter.includes(othersId), 'Re-tagged item should immediately appear in documentary view');

    await assert.rejects(() => mediaDB.updateCategory(othersId, 'invalid-cat'));
  } finally {
    await mediaDB.delete(docId);
    await mediaDB.delete(docByGenreId);
    await mediaDB.delete(othersId);
  }
});

test('Social playlist detection, normalization, series-style grouping, UI rendering, and autoplay queue', async () => {
  // 1. Playlist URL intent detection
  const ytPlaylist = detectPlaylistIntent('https://www.youtube.com/playlist?list=PL1234567890');
  assert.equal(ytPlaylist.isExplicitPlaylist, true);
  assert.equal(ytPlaylist.isAutoMix, false);

  const ytWatchWithList = detectPlaylistIntent('https://www.youtube.com/watch?v=abc123&list=PL1234567890');
  assert.equal(ytWatchWithList.isExplicitPlaylist, false);
  assert.equal(ytWatchWithList.hasPlaylistParam, true);
  assert.equal(ytWatchWithList.isAutoMix, false);

  const ytAutoMix = detectPlaylistIntent('https://www.youtube.com/watch?v=abc123&list=RDMMabc123');
  assert.equal(ytAutoMix.isAutoMix, true);
  assert.equal(ytAutoMix.isExplicitPlaylist, false);

  const fbPlaylist = detectPlaylistIntent('https://www.facebook.com/watch/playlist/123456789');
  assert.equal(fbPlaylist.isExplicitPlaylist, true);

  const igHighlight = detectPlaylistIntent('https://www.instagram.com/stories/highlights/17999999999/');
  assert.equal(igHighlight.isExplicitPlaylist, true);

  // 2. Flat playlist entry normalization skips unavailable videos & resolves YouTube URLs
  const entries = normalizePlaylistEntries(
    {
      title: 'Systems Design Crash Course',
      uploader: 'TechChannel',
      entries: [
        { id: 'vid001', title: 'Load Balancing', url: 'vid001', duration: 180 },
        { id: 'vid002', title: '[Private video]', url: 'vid002' },
        { id: 'vid003', title: 'Caching Strategies', url: 'https://www.youtube.com/watch?v=vid003', duration: 240 },
        { id: 'vid004', title: 'Sharding Deep Dive', url: 'vid004', duration: 300 },
      ],
    },
    'https://www.youtube.com/playlist?list=PLtest',
    { id: 'youtube', label: 'YouTube' },
    50
  );
  assert.equal(entries.length, 3);
  assert.equal(entries[0].url, 'https://www.youtube.com/watch?v=vid001');
  assert.equal(entries[1].title, 'Caching Strategies');

  // 3. Build playlist metadata, store in mediaDB, verify series-style grouping & autoplay
  const savedIds = [];
  const standaloneId = 'test-social-standalone-clip';
  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const meta = buildSocialMediaMetadata({
        info: {
          title: e.title,
          description: `Episode ${i + 1} overview.`,
          duration: e.duration,
          upload_date: '20260510',
          height: 1080,
          uploader: 'TechChannel',
        },
        platform: { id: 'youtube', label: 'YouTube' },
        customName: '',
        gcsPath: `Social/YouTube/Systems Design Crash Course/S01E0${i + 1}-${e.id}.mp4`,
        sizeBytes: 15_000_000,
        categoryOverride: 'others',
        playlistMeta: {
          seriesName: 'Systems Design Crash Course',
          seriesPlot: 'Complete systems design YouTube playlist by TechChannel.',
          uploader: 'TechChannel',
          season: 1,
          episode: i + 1,
          totalEpisodes: entries.length,
        },
      });
      const saved = await mediaDB.upsert(meta);
      savedIds.push(saved.id);
    }

    await mediaDB.upsert({
      id: standaloneId,
      type: 'others',
      title: 'Standalone Short Clip',
      tags: ['YouTube', 'Others'],
      genres: ['Others'],
      filename: 'Standalone.mp4',
      gcs_path: 'Social/YouTube/Standalone.mp4',
    });

    // Verify getSeriesSeasons returns non-TV-series playlists with is_playlist=true and ordered episodes
    const seasonsData = mediaDB.getSeriesSeasons('Systems Design Crash Course');
    assert.ok(seasonsData.series, 'Playlist must resolve through getSeriesSeasons');
    assert.equal(seasonsData.series.is_playlist, true);
    assert.equal(seasonsData.seasons[1].length, 3);
    assert.equal(seasonsData.seasons[1][0].episode, 1);
    assert.equal(seasonsData.seasons[1][2].episode, 3);

    // Verify player autoplay queue transitions Video 1 -> Video 2 -> Video 3 -> null
    const step1 = resolveNextSeriesEpisode(seasonsData, seasonsData.seasons[1][0]);
    assert.equal(step1.nextEpisode?.id, seasonsData.seasons[1][1].id);
    const step2 = resolveNextSeriesEpisode(seasonsData, seasonsData.seasons[1][1]);
    assert.equal(step2.nextEpisode?.id, seasonsData.seasons[1][2].id);
    const step3 = resolveNextSeriesEpisode(seasonsData, seasonsData.seasons[1][2]);
    assert.equal(step3.nextEpisode, null);

    // Verify collapseGroupedMedia collapses 3 playlist videos into 1 card + keeps 1 standalone card
    const othersItems = mediaDB.getAll({ type: 'others' }).filter(
      (m) => savedIds.includes(m.id) || m.id === standaloneId
    );
    const collapsed = collapseGroupedMedia(othersItems);
    assert.equal(collapsed.length, 2, '3 playlist videos + 1 standalone clip should collapse into 2 cards');
    const playlistCard = collapsed.find((c) => c.is_series_group);
    assert.ok(playlistCard, 'Expected grouped playlist card');
    assert.equal(playlistCard.is_playlist, true);
    assert.equal(playlistCard.episodes_count, 3);

    // Verify Playlist card & modal rendering
    const cardHtml = renderSeriesCard(playlistCard);
    assert.ok(cardHtml.includes('Playlist • 3 Videos'), 'Card badge must show Playlist • 3 Videos');
    const modalHtml = renderSeriesModalContent(seasonsData, 1, { isOwner: true });
    assert.ok(modalHtml.includes('Play Playlist'), 'Modal CTA must say Play Playlist');
    assert.ok(modalHtml.includes('Autoplay Enabled'), 'Modal must display Autoplay Enabled badge');
    assert.ok(modalHtml.includes('Video 1') && modalHtml.includes('Video 3'), 'Modal must list playlist videos');
    assert.ok(!modalHtml.includes('series-retag-btn'), 'Playlist modal should not show Gemini TV Re-tag button');

    // Verify changing category of a playlist item preserves series_name grouping
    const recategorized = await mediaDB.updateCategory(savedIds[0], 'documentary');
    assert.equal(recategorized.series_name, 'Systems Design Crash Course');
  } finally {
    for (const sid of savedIds) {
      await mediaDB.delete(sid);
    }
    await mediaDB.delete(standaloneId);
  }
});

test('Zero-tmpfs streaming format selection handles multi-GB Twitter progressive MP4, standard YouTube 1080p, large YouTube DASH, and Vault NSFW routing', () => {
  // 1. Twitter/X multi-GB 1080p progressive MP4 alongside video-only HLS -> selects direct progressive MP4
  const twitterInfo = {
    title: 'DP 🔞 - #anal #pawg #nsfwtwt',
    duration: 3415,
    age_limit: 18,
    formats: [
      { format_id: 'hls-audio-128000', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'none', tbr: 128 },
      { format_id: 'http-2176', ext: 'mp4', protocol: 'https', height: 720, tbr: 2176, filesize: 928_000_000, url: 'https://video.twimg.com/720.mp4' },
      { format_id: 'http-10368', ext: 'mp4', protocol: 'https', height: 1080, tbr: 10368, filesize: 4_425_925_535, url: 'https://video.twimg.com/1080.mp4' },
      { format_id: 'hls-5523', ext: 'mp4', protocol: 'm3u8_native', height: 1080, vcodec: 'avc1', acodec: 'none', tbr: 5523, url: 'https://video.twimg.com/1080.m3u8' },
    ],
  };

  const chosenTw = selectDirectProgressiveFormat(twitterInfo);
  assert.equal(chosenTw?.format_id, 'http-10368', 'Must select 1080p progressive MP4 for zero-RAM GCS streaming');

  // 2. Standard 10-min YouTube video (360p progressive + 1080p small DASH) -> returns null so yt-dlp merges full 1080p
  const normalYtInfo = {
    title: 'JavaScript in 100 Seconds',
    duration: 120,
    formats: [
      { format_id: '18', ext: 'mp4', protocol: 'https', height: 360, vcodec: 'avc1', acodec: 'mp4a', tbr: 600, url: 'https://rr1.googlevideo.com/360.mp4' },
      { format_id: '137', ext: 'mp4', protocol: 'https', height: 1080, vcodec: 'avc1', acodec: 'none', filesize: 35_000_000, url: 'https://rr1.googlevideo.com/1080.mp4' },
      { format_id: '140', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a', filesize: 2_000_000, url: 'https://rr1.googlevideo.com/audio.m4a' },
    ],
  };
  assert.equal(selectDirectProgressiveFormat(normalYtInfo), null);
  assert.equal(selectLargeSplitHttpsFormats(normalYtInfo), null);

  // 3. Long 3-hour YouTube 1080p DASH (> 1.35 GiB) -> selects split HTTPS pipe for zero-tmpfs FFmpeg streaming
  const hugeYtInfo = {
    title: 'Full 3-Hour Documentary',
    duration: 10800,
    formats: [
      { format_id: '18', ext: 'mp4', protocol: 'https', height: 360, vcodec: 'avc1', acodec: 'mp4a', tbr: 500, url: 'https://rr1.googlevideo.com/360.mp4' },
      { format_id: '137', ext: 'mp4', protocol: 'https', height: 1080, vcodec: 'avc1', acodec: 'none', filesize: 2_200_000_000, url: 'https://rr1.googlevideo.com/1080.mp4' },
      { format_id: '140', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a', filesize: 170_000_000, url: 'https://rr1.googlevideo.com/audio.m4a' },
    ],
  };
  assert.equal(selectDirectProgressiveFormat(hugeYtInfo), null);
  const split = selectLargeSplitHttpsFormats(hugeYtInfo);
  assert.equal(split?.video?.format_id, '137');
  assert.equal(split?.audio?.format_id, '140');

  // 4. NSFW social video routes safely into Private Vault while normal video stays non-adult
  assert.equal(detectSocialAdultContent(twitterInfo), true);
  const adultMeta = buildSocialMediaMetadata({
    info: { ...twitterInfo, height: 1080 },
    platform: { id: 'twitter', label: 'Twitter' },
    customName: '',
    gcsPath: 'Social/Twitter/nsfw-clip.mp4',
    sizeBytes: 2_360_533_794,
    categoryOverride: 'others',
  });
  assert.equal(adultMeta.is_adult, true);
  assert.ok(adultMeta.genres.includes('Adult'));
  assert.ok(adultMeta.tags.includes('Private'));

  assert.equal(detectSocialAdultContent(normalYtInfo), false);
});

test('Bulk series/playlist category move and individual/collection tag & genre editing prevent duplicate categorization', async () => {
  const pl1 = 'test-move-pl-1';
  const pl2 = 'test-move-pl-2';
  const expEp1 = 'test-expanse-s01e01';
  const expSpecial = 'test-expanse-s04e00';

  try {
    // Seed a 2-video YouTube playlist initially in Others
    await mediaDB.upsert({
      id: pl1,
      type: 'others',
      series_name: 'Test Bubble Playlist',
      season: 1,
      episode: 1,
      title: 'Test Bubble Playlist - S01E01: Part 1',
      genres: ['Others', 'YouTube'],
      tags: ['YouTube', 'Playlist', 'Others'],
      filename: 'S01E01-Part1.mp4',
      gcs_path: 'Social/YouTube/TestBubble/S01E01.mp4',
    });
    await mediaDB.upsert({
      id: pl2,
      type: 'others',
      series_name: 'Test Bubble Playlist',
      season: 1,
      episode: 2,
      title: 'Test Bubble Playlist - S01E02: Part 2',
      genres: ['Others', 'YouTube'],
      tags: ['YouTube', 'Playlist', 'Others'],
      filename: 'S01E02-Part2.mp4',
      gcs_path: 'Social/YouTube/TestBubble/S01E02.mp4',
    });

    // Seed a Sci-Fi series whose bonus special erroneously carried Documentary genre
    await mediaDB.upsert({
      id: expEp1,
      type: 'series',
      series_name: 'Test Expanse Show',
      season: 1,
      episode: 1,
      title: 'Test Expanse Show S01E01: Dulcinea',
      genres: ['Sci-Fi', 'Drama'],
      tags: ['Space'],
      filename: 'Expanse.S01E01.mkv',
      gcs_path: 'Shows/TestExpanse.S01E01.mkv',
    });
    await mediaDB.upsert({
      id: expSpecial,
      type: 'series',
      series_name: 'Test Expanse Show',
      season: 4,
      episode: 0,
      title: 'Test Expanse Show S04E00: Recap Special',
      genres: ['Sci-Fi', 'Drama', 'Documentary'],
      tags: ['Recap'],
      filename: 'Expanse.S04E00.mkv',
      gcs_path: 'Shows/TestExpanse.S04E00.mkv',
    });

    // 1. Move entire playlist from Others -> Documentary
    const movedPl = await mediaDB.updateSeriesCategory('Test Bubble Playlist', 'documentary');
    assert.equal(movedPl.updatedCount, 2);

    const inDocs = mediaDB.getAll({ type: 'documentary' }).map((m) => m.id);
    const inOthers = mediaDB.getAll({ type: 'others' }).map((m) => m.id);
    const inTvSeries = mediaDB.getSeriesGrouped().map((s) => s.series_name);
    assert.ok(inDocs.includes(pl1) && inDocs.includes(pl2), 'Moved playlist items must appear in Documentary');
    assert.ok(!inOthers.includes(pl1) && !inOthers.includes(pl2), 'Moved playlist items must leave Others');
    assert.ok(!inTvSeries.includes('Test Bubble Playlist'), 'Documentary playlist must NOT duplicate into TV Shows');

    // Playlist remains grouped & playable with Autoplay via getSeriesSeasons
    const plSeasons = mediaDB.getSeriesSeasons('Test Bubble Playlist');
    assert.equal(plSeasons.seasons[1].length, 2);
    assert.equal(plSeasons.series.type, 'documentary');
    assert.equal(plSeasons.series.is_playlist, true);

    // 2. Tag & untag entire playlist cleanly
    await mediaDB.updateSeriesTags('Test Bubble Playlist', {
      addTags: ['History', 'Economics'],
      removeTags: ['YouTube'],
    });
    const updatedPlSeasons = mediaDB.getSeriesSeasons('Test Bubble Playlist');
    assert.ok(updatedPlSeasons.series.tags.includes('History'));
    assert.ok(updatedPlSeasons.series.tags.includes('Economics'));
    assert.ok(!updatedPlSeasons.series.tags.includes('YouTube'));

    // Owner modal renders move-category & tag editor; Member modal hides them
    const ownerModal = renderSeriesModalContent(updatedPlSeasons, 1, { isOwner: true });
    const memberModal = renderSeriesModalContent(updatedPlSeasons, 1, { isOwner: false });
    assert.ok(ownerModal.includes('series-category-chip') && ownerModal.includes('series-tag-editor-form'));
    assert.ok(!memberModal.includes('series-category-chip') && !memberModal.includes('series-tag-editor-form'));

    // 3. Remove erroneous Documentary genre from individual episode OR move whole series to TV Series
    await mediaDB.updateTags(expSpecial, { removeGenres: ['Documentary'], addTags: ['Bonus'] });
    const docsAfterUntag = mediaDB.getAll({ type: 'documentary' }).map((m) => m.id);
    assert.ok(!docsAfterUntag.includes(expSpecial), 'Untagged Sci-Fi special must no longer appear in Documentary');
    assert.ok(mediaDB.getById(expSpecial).tags.includes('Bonus'));
  } finally {
    await mediaDB.delete(pl1);
    await mediaDB.delete(pl2);
    await mediaDB.delete(expEp1);
    await mediaDB.delete(expSpecial);
  }
});
