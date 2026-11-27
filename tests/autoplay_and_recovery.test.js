import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KodimiPlayer,
  isVodPlaybackCompleted,
  isPrematureStreamEnd,
  formatEpisodeCode,
  resolveNextSeriesEpisode,
} from '../public/js/player.js';
import { api } from '../public/js/api.js?v=33';
import { rejectNonZeroByteRange } from '../server/services/transcoder.js';
import { mediaDB, playbackDB, isPlaybackCompleted } from '../server/db/database.js';

/**
 * Minimal DOM harness for exercising KodimiPlayer's full event & state machine in Node.js.
 */
function setupMockPlayerDom(t) {
  const createClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const shouldAdd = force !== undefined ? Boolean(force) : !set.has(c);
        if (shouldAdd) set.add(c);
        else set.delete(c);
        return shouldAdd;
      },
    };
  };

  const makeElement = (id = '', tagName = 'DIV', initialClasses = []) => {
    const listeners = new Map();
    return {
      id,
      tagName,
      style: { display: '' },
      dataset: {},
      textContent: '',
      innerHTML: '',
      title: '',
      value: '1',
      src: '',
      alt: '',
      classList: createClassList(initialClasses),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(type, payload = {}) {
        const fns = listeners.get(type) || [];
        for (const fn of fns) {
          fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...payload });
        }
      },
      querySelector() {
        return makeElement();
      },
      querySelectorAll() {
        return [];
      },
      appendChild() {},
      remove() {},
      removeAttribute(attr) {
        if (attr === 'src') this.src = '';
      },
      focus() {},
      getBoundingClientRect() {
        return { left: 0, width: 1000 };
      },
    };
  };

  const elements = new Map();
  const getOrMake = (id) => {
    if (!elements.has(id)) {
      const initialCls = id === 'player-container' ? ['player-hidden'] : [];
      elements.set(id, makeElement(id, 'DIV', initialCls));
    }
    return elements.get(id);
  };

  const video = makeElement('player-video', 'VIDEO');
  video.currentTime = 0;
  video.duration = NaN;
  video.paused = true;
  video.ended = false;
  video.readyState = 4;
  video.playbackRate = 1;
  video.volume = 1;
  video.muted = false;
  video.error = null;
  video.buffered = { length: 0, end: () => 0 };
  video.canPlayType = (mime) => (mime.includes('av01') || mime.includes('hvc1') ? 'probably' : '');
  video.load = () => {};
  video.play = () => {
    video.paused = false;
    video.ended = false;
    return Promise.resolve();
  };
  video.pause = () => {
    video.paused = true;
  };
  elements.set('player-video', video);

  const loaderText = makeElement('player-loader-text', 'SPAN');
  const storageMap = new Map();

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevStorage = globalThis.localStorage;
  const prevSessionStorage = globalThis.sessionStorage;
  const prevCustomEvent = globalThis.CustomEvent;

  const docListeners = new Map();
  globalThis.document = {
    body: { style: {} },
    visibilityState: 'visible',
    fullscreenElement: null,
    getElementById: (id) => (id === 'kodimi-sub-track' ? null : getOrMake(id)),
    querySelector: (sel) => (sel === '.player-loader-text' ? loaderText : makeElement()),
    createElement: (tag) => makeElement('', tag.toUpperCase()),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    exitFullscreen: () => Promise.resolve(),
  };

  globalThis.window = {
    location: { protocol: 'https:' },
    addEventListener() {},
    dispatchEvent() {},
  };

  globalThis.localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
  };

  globalThis.sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, opts = {}) {
        this.type = type;
        this.detail = opts.detail;
      }
    };
  }

  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.localStorage = prevStorage;
    globalThis.sessionStorage = prevSessionStorage;
    globalThis.CustomEvent = prevCustomEvent;
  });

  return { elements, video, loaderText, storageMap };
}

test('rejectNonZeroByteRange blocks mid-stream HTTP byte-range restarts with 416 while allowing initial probes', () => {
  const makeMockRes = () => ({
    headersSent: false,
    statusCode: null,
    headers: null,
    ended: false,
    writeHead(code, hdrs) {
      this.statusCode = code;
      this.headers = hdrs;
      this.headersSent = true;
    },
    end() {
      this.ended = true;
    },
  });

  // 1. Standard progressive GET (no Range header) -> allowed
  const resNoRange = makeMockRes();
  assert.equal(rejectNonZeroByteRange({ headers: {} }, resNoRange), false);
  assert.equal(resNoRange.statusCode, null);

  // 2. Initial byte-0 probe (Range: bytes=0-) -> allowed
  const resZeroRange = makeMockRes();
  assert.equal(rejectNonZeroByteRange({ headers: { range: 'bytes=0-' } }, resZeroRange), false);
  assert.equal(resZeroRange.statusCode, null);

  // 3. Mid-stream browser socket reconnect (Range: bytes=78451200-) -> rejected with 416
  const resMidRange = makeMockRes();
  assert.equal(rejectNonZeroByteRange({ headers: { range: 'bytes=78451200-' } }, resMidRange), true);
  assert.equal(resMidRange.statusCode, 416);
  assert.equal(resMidRange.headers['Content-Range'], 'bytes */*');
  assert.equal(resMidRange.ended, true);
});

test('Exact Verity regression: mid-stream Cloud Run 3600s cutoff reconnects at 4551.52s without stale seekTimeOffset or subtitle drift', async (t) => {
  const { video } = setupMockPlayerDom(t);

  const savedProgressCalls = [];
  const origSaveProgress = api.saveProgress;
  const origGetSubTracks = api.getSubtitleTracks;
  const origFetch = globalThis.fetch;

  api.saveProgress = async (mediaId, currentTime, duration, completed, opts) => {
    savedProgressCalls.push({ mediaId, currentTime, duration, completed, opts });
    return { success: true };
  };
  api.getSubtitleTracks = async () => ({
    tracks: [{ id: 'embedded_0', trackIndex: 0, language: 'en', label: 'English' }],
  });
  globalThis.fetch = async () => ({
    ok: true,
    text: async () =>
      `WEBVTT\n\n00:07:38.000 --> 00:07:42.000\nEarly scene line at 458s\n\n01:50:59.000 --> 01:51:04.000\nClimax line at 6660s\n`,
  });

  t.after(() => {
    api.saveProgress = origSaveProgress;
    api.getSubtitleTracks = origGetSubTracks;
    globalThis.fetch = origFetch;
  });

  const player = new KodimiPlayer();
  t.after(() => {
    player.cancelPendingTimers();
    player.stopPlaybackSyncLoop();
    if (player.progressInterval) clearInterval(player.progressInterval);
  });

  const verity = {
    id: '795a6fcf4d9703172b500d2a94bb0a0c',
    title: 'Verity',
    type: 'movie',
    duration: 7257,
    gcs_path: 'Verity.2026.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir.mkv',
  };

  // 1. Resume Verity at 456.07s and switch to 480p AV1
  player.open(verity, 456.07);
  await new Promise((r) => setTimeout(r, 10));
  await player.setSubtitleTrackById('embedded_0');

  player.changeQuality('480p');
  assert.equal(player.seekTimeOffset, 456.07);
  assert.equal(player.getEffectiveCodec(), 'av1');

  // 2. Simulate 68 minutes of movie progression (456.07s -> 4551.52s, raw stream time = 4095.45s)
  video.paused = false;
  video.currentTime = 5.0;
  video.dispatchEvent('playing');
  video.dispatchEvent('timeupdate');
  assert.equal(player.hasEstablishedPlayback, true);

  video.currentTime = 4095.45;
  video.dispatchEvent('timeupdate');
  assert.ok(Math.abs(player.getEffectiveCurrentTime() - 4551.52) < 0.01);

  // 3. Simulate Cloud Run 3600s hard timeout severing progressive fMP4 mid-fragment (MEDIA_ERR_DECODE = 3)
  video.error = { code: 3 };
  video.dispatchEvent('error');

  // AV1 must NOT be disabled because playback was already established
  assert.equal(player.supportedCodecs.av1, true, 'Mid-stream timeout must not disable AV1 support');
  assert.ok(Math.abs(player.seekTimeOffset - 4551.52) < 0.01, 'seekTimeOffset must lock immediately to 4551.52s');

  // Wait for 800ms first-attempt reconnect timer to fire loadVideoSource(retryUrl, 4551.52)
  await new Promise((r) => setTimeout(r, 900));

  assert.ok(video.src.includes('time=4551.52'), `Expected reconnect URL at time=4551.52, got ${video.src}`);
  assert.ok(Math.abs(player.seekTimeOffset - 4551.52) < 0.01, 'loadVideoSource must keep seekTimeOffset at 4551.52s');

  // 4. New stream starts from raw video.currentTime = 0 and plays 2108.84s to 6660.36s (91.78%)
  video.error = null;
  video.paused = false;
  video.currentTime = 0;
  video.dispatchEvent('playing');
  video.currentTime = 2108.84;
  video.dispatchEvent('timeupdate');

  // Effective time MUST be 6660.36s (NOT the buggy 456.07 + 2108.84 = 2564.91s!)
  assert.ok(
    Math.abs(player.getEffectiveCurrentTime() - 6660.36) < 0.02,
    `Expected effective time 6660.36s, got ${player.getEffectiveCurrentTime()}`
  );
  assert.equal(
    player.subtitleDisplay.innerHTML,
    'Climax line at 6660s',
    'Subtitles must stay synchronized to 6660.36s after mid-stream reconnect'
  );

  // 5. Advance 25s more into end credits (6685.36s = 92.12% >= 92%) and close player
  video.currentTime = 2133.84;
  video.dispatchEvent('timeupdate');
  player.close();
  await new Promise((r) => setTimeout(r, 20));

  const lastSave = savedProgressCalls.at(-1);
  assert.ok(lastSave, 'Closing player must persist final playback progress');
  assert.ok(Math.abs(lastSave.currentTime - 6685.36) < 0.05);
  assert.equal(lastSave.completed, 1, 'Reaching >= 92% end credits must persist completed = 1');
});

test('Premature ended and unsolicited browser loadstart keep monotonic time and trigger seamless reconnect', async (t) => {
  const { video } = setupMockPlayerDom(t);
  const origGetSubTracks = api.getSubtitleTracks;
  api.getSubtitleTracks = async () => ({ tracks: [] });
  t.after(() => {
    api.getSubtitleTracks = origGetSubTracks;
  });

  const player = new KodimiPlayer();
  t.after(() => {
    player.cancelPendingTimers();
    player.stopPlaybackSyncLoop();
    if (player.progressInterval) clearInterval(player.progressInterval);
  });

  player.open({ id: 'movie-premature', title: 'Long Movie', type: 'movie', duration: 7200 }, 100);
  video.paused = false;
  video.currentTime = 1700; // Effective = 1800s of 7200s
  video.dispatchEvent('playing');
  video.dispatchEvent('timeupdate');
  assert.equal(player.hasEstablishedPlayback, true);
  assert.equal(player.getEffectiveCurrentTime(), 1800);

  // Simulate unsolicited browser reset to currentTime=0 before error/loadstart
  video.currentTime = 0;
  assert.equal(
    player.getEffectiveCurrentTime(),
    1800,
    'Monotonic guard must prevent sudden currentTime=0 drop from snapping backward to seekTimeOffset'
  );

  // Simulate premature 'ended' on empty_moov fragment boundary at 1800s / 7200s
  assert.equal(isPrematureStreamEnd(1800, 7200), true);
  assert.equal(isPrematureStreamEnd(7180, 7200), false);
  video.dispatchEvent('ended');

  assert.equal(player.recoveryAttempts, 1, 'Premature ended must schedule stream recovery');
  assert.equal(player.seekTimeOffset, 1800);
});

test('isPlaybackCompleted and playbackDB filter >= 92% finished items out of Continue Watching', async () => {
  assert.equal(isPlaybackCompleted(6680, 7257, false), true);
  assert.equal(isPlaybackCompleted(6500, 7257, false), false);
  assert.equal(isPlaybackCompleted(1200, 7257, true), true);
  assert.equal(isVodPlaybackCompleted(6680, 7257, false), true);

  const profileId = '__test_profile_cw__';
  const unfinishedId = '__test_cw_unfinished__';
  const creditsDoneId = '__test_cw_credits_done__';

  try {
    await mediaDB.upsert({
      id: unfinishedId,
      title: 'Halfway Movie',
      type: 'movie',
      gcs_path: '__test_cw_unfinished__.mkv',
      duration: 6000,
    });
    await mediaDB.upsert({
      id: creditsDoneId,
      title: 'Credits Reached Movie',
      type: 'movie',
      gcs_path: '__test_cw_credits_done__.mkv',
      duration: 6000,
    });

    await playbackDB.saveProgress(unfinishedId, 2400, 6000, 0, profileId);
    const savedDone = await playbackDB.saveProgress(creditsDoneId, 5580, 6000, 0, profileId); // 93%
    assert.equal(savedDone.completed, true);

    let cw = playbackDB.getContinueWatching(profileId, 15, false);
    assert.deepEqual(cw.map((m) => m.id), [unfinishedId]);

    // Dismissing via markCompleted removes unfinishedId from Continue Watching immediately
    await playbackDB.markCompleted(unfinishedId, profileId);
    cw = playbackDB.getContinueWatching(profileId, 15, false);
    assert.deepEqual(cw, []);
  } finally {
    await playbackDB.deleteProgress(unfinishedId, profileId);
    await playbackDB.deleteProgress(creditsDoneId, profileId);
    await mediaDB.delete(unfinishedId);
    await mediaDB.delete(creditsDoneId);
  }
});

test('resolveNextSeriesEpisode and Series Autoplay transition across episodes & seasons while preserving quality and subtitles', async (t) => {
  const seasonsData = {
    series: { series_name: 'The Last Airbender' },
    seasonNumbers: [1, 2],
    seasons: {
      1: [
        { id: 'ep_s1e1', title: 'The Last Airbender - S01E01 - The Boy in the Iceberg', type: 'series', series_name: 'The Last Airbender', season: 1, episode: 1, duration: 1440 },
        { id: 'ep_s1e2', title: 'The Last Airbender - S01E02 - The Avatar Returns', type: 'series', series_name: 'The Last Airbender', season: 1, episode: 2, duration: 1440 },
        // Missing E03 & E04 -> jumps cleanly to E05
        { id: 'ep_s1e5', title: 'The Last Airbender - S01E05 - The King of Omashu', type: 'series', series_name: 'The Last Airbender', season: 1, episode: 5, duration: 1440 },
      ],
      2: [
        { id: 'ep_s2e1', title: 'The Last Airbender - S02E01 - The Avatar State', type: 'series', series_name: 'The Last Airbender', season: 2, episode: 1, duration: 1450 },
      ],
    },
  };

  assert.equal(resolveNextSeriesEpisode(seasonsData, { id: 'ep_s1e1' }).nextEpisode?.id, 'ep_s1e2');
  assert.equal(resolveNextSeriesEpisode(seasonsData, { id: 'ep_s1e2' }).nextEpisode?.id, 'ep_s1e5');
  assert.equal(
    resolveNextSeriesEpisode(seasonsData, { id: 'ep_s1e5' }).nextEpisode?.id,
    'ep_s2e1',
    'Season 1 finale must advance automatically to Season 2 Episode 1'
  );
  assert.equal(resolveNextSeriesEpisode(seasonsData, { id: 'ep_s2e1' }).nextEpisode, null);
  assert.equal(formatEpisodeCode(seasonsData.seasons[1][1]), 'S01E02 • The Avatar Returns');

  // Exercise KodimiPlayer Up Next preview + autoplay transition preserving 480p & English subtitles
  const { elements, video } = setupMockPlayerDom(t);
  const origGetSeasons = api.getSeriesSeasons;
  const origGetSubTracks = api.getSubtitleTracks;
  const origSaveProgress = api.saveProgress;
  const origFetch = globalThis.fetch;

  const progressCalls = [];
  api.getSeriesSeasons = async () => seasonsData;
  api.saveProgress = async (mediaId, currentTime, duration, completed) => {
    progressCalls.push({ mediaId, currentTime, duration, completed });
    return { success: true };
  };
  api.getSubtitleTracks = async (mediaId) => ({
    tracks: [
      { id: `${mediaId}_fr`, trackIndex: 0, language: 'fr', label: 'French' },
      { id: `${mediaId}_en`, trackIndex: 1, language: 'en', label: 'English CC' },
    ],
  });
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => 'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nPreviously on Avatar...\n',
  });

  t.after(() => {
    api.getSeriesSeasons = origGetSeasons;
    api.getSubtitleTracks = origGetSubTracks;
    api.saveProgress = origSaveProgress;
    globalThis.fetch = origFetch;
  });

  const player = new KodimiPlayer();
  t.after(() => {
    player.cancelPendingTimers();
    player.stopPlaybackSyncLoop();
    if (player.progressInterval) clearInterval(player.progressInterval);
  });

  player.open(seasonsData.seasons[1][0], 0);
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(player.nextEpisode?.id, 'ep_s1e2');
  assert.equal(elements.get('player-next-ep-btn').style.display, 'flex');
  assert.equal(elements.get('player-autoplay-btn').style.display, 'flex');

  // User chooses 480p and English subtitles on S01E01
  player.changeQuality('480p');
  await player.setSubtitleTrackById('ep_s1e1_en');
  assert.equal(player.selectedQuality, '480p');
  assert.equal(player.subtitlesEnabled, true);

  // Hide bottom overlay and advance into final 18s (1422s / 1440s) -> Up Next preview card must appear!
  elements.get('player-overlay-bottom').classList.add('player-hidden');
  video.paused = false;
  video.currentTime = 1422;
  video.dispatchEvent('playing');
  video.dispatchEvent('timeupdate');

  assert.equal(player.upNextMode, 'preview');
  assert.equal(elements.get('player-upnext-card').style.display, 'flex');
  assert.equal(elements.get('player-upnext-title').textContent, 'S01E02 • The Avatar Returns');

  // Trigger genuine 'ended' at 1440s -> starts 5s countdown and marks ep_s1e1 completed
  video.currentTime = 1440;
  video.ended = true;
  video.dispatchEvent('ended');
  assert.equal(player.upNextMode, 'countdown');
  assert.equal(progressCalls.some((c) => c.mediaId === 'ep_s1e1' && c.completed === 1), true);

  // Trigger transition (Play Next button / countdown reaching 0)
  player.playNextEpisode();
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(player.currentMedia.id, 'ep_s1e2');
  assert.equal(player.selectedQuality, '480p', 'User-selected VOD quality must persist across autoplayed episodes');
  assert.equal(player.activeSubtitleId, 'ep_s1e2_en', 'Matching English subtitle track must auto-activate on next episode');
  assert.equal(player.nextEpisode?.id, 'ep_s1e5', 'Next episode pointer must advance to S01E05');
});
