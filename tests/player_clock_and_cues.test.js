import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HybridPlaybackClock,
  parseSubtitleText,
  findActiveSubtitleCues,
  buildShiftedWebVtt,
  isSmartTvUserAgent,
  canDirectPlayNativeMp4,
} from '../public/js/player.js';

test('HybridPlaybackClock tracks native video.currentTime and extrapolates seamlessly when VIDAA freezes currentTime', () => {
  let wallNowMs = 100_000;
  const clock = new HybridPlaybackClock(() => wallNowMs, 900);

  // Open remux stream seeked to 600s (10:00) of a 2400s episode
  clock.reset({
    seekOffsetSec: 600,
    isDirectMode: false,
    initialRawSec: 0,
    durationSec: 2400,
  });

  clock.onPlaying(0, 1, wallNowMs);
  assert.equal(clock.getEffectiveTime(0, wallNowMs), 600);

  // First 3.5 seconds: native video.currentTime advances normally
  wallNowMs += 1000;
  assert.equal(clock.getEffectiveTime(1.0, wallNowMs), 601.0);
  wallNowMs += 2500;
  assert.equal(clock.getEffectiveTime(3.5, wallNowMs), 603.5);
  assert.equal(clock.isExtrapolating(wallNowMs), false);

  // Now simulate Hisense VIDAA hardware overlay bug: video.currentTime freezes at 3.5s while audio/video keep playing
  wallNowMs += 500; // 500ms < 900ms threshold -> still anchored at 3.5s
  assert.equal(clock.getEffectiveTime(3.5, wallNowMs), 603.5);

  wallNowMs += 1500; // Total 2.0s elapsed since last raw advance -> smooth wall-clock extrapolation!
  assert.equal(clock.isExtrapolating(wallNowMs), true);
  assert.ok(Math.abs(clock.getEffectiveTime(3.5, wallNowMs) - 605.5) < 0.01);

  wallNowMs += 10_000; // +10s later (12.0s after 3.5s) -> 615.5s
  assert.ok(Math.abs(clock.getEffectiveTime(3.5, wallNowMs) - 615.5) < 0.01);

  // Simulate user pausing for 8 seconds while video.currentTime is still frozen at 3.5s
  clock.onPauseOrWait(3.5, wallNowMs);
  wallNowMs += 8000;
  assert.ok(
    Math.abs(clock.getEffectiveTime(3.5, wallNowMs) - 615.5) < 0.01,
    'Clock must NOT drift forward while paused or buffering'
  );

  // Resume playback while video.currentTime is STILL stuck at 3.5s: must continue monotonically from 615.5s!
  clock.onPlaying(3.5, 1, wallNowMs);
  wallNowMs += 4000;
  assert.ok(
    Math.abs(clock.getEffectiveTime(3.5, wallNowMs) - 619.5) < 0.01,
    'Clock must resume monotonically from 615.5s without snapping back to 603.5s'
  );

  // If browser later emits a real updated video.currentTime (e.g. 22.0s), re-anchor cleanly
  wallNowMs += 2500;
  assert.equal(clock.getEffectiveTime(22.0, wallNowMs), 622.0);
  assert.equal(clock.isExtrapolating(wallNowMs), false);

  // Clamps to durationSec
  wallNowMs += 5_000_000;
  assert.equal(clock.getEffectiveTime(22.0, wallNowMs), 2400);
});

test('findActiveSubtitleCues performs O(log N) binary search accurately across 1500 cues and overlapping dialogue', () => {
  const cues = [];
  // Long top-screen sign cue spanning 10.0s -> 25.0s overlapping multiple short dialogue cues
  cues.push({ start: 10.0, end: 25.0, text: '[Location: Neo-Tokyo]' });
  for (let i = 0; i < 1500; i++) {
    const start = i * 2 + 0.5;
    const end = start + 1.2;
    cues.push({ start, end, text: `Line ${i}` });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  assert.deepEqual(findActiveSubtitleCues(cues, 0.1), []);

  // At t = 15.0s: both the long sign cue [10..25] and Line 7 [14.5..15.7] must be returned in start order
  const activeAt15 = findActiveSubtitleCues(cues, 15.0);
  assert.deepEqual(
    activeAt15.map((c) => c.text),
    ['[Location: Neo-Tokyo]', 'Line 7']
  );

  // At t = 2999.0s (near end of 50-minute episode): Line 1499 [2998.5..2999.7]
  const activeLate = findActiveSubtitleCues(cues, 2999.0);
  assert.deepEqual(
    activeLate.map((c) => c.text),
    ['Line 1499']
  );

  assert.deepEqual(findActiveSubtitleCues(cues, 3500.0), []);
});

test('buildShiftedWebVtt shifts episode cues into remuxed stream coordinates and clamps boundary cues', () => {
  const srt = `1
00:01:25,000 --> 00:01:28,000
Before seek point

2
00:01:29,000 --> 00:01:32,500
Partially overlapping seek point

3
00:01:40,000 --> 00:01:43,250
After seek point
`;
  const cues = parseSubtitleText(srt, 'episode.srt');
  // Seeked to 90s (01:30) with +0.5s subtitle delay -> shiftSec = 0.5 - 90 = -89.5s
  const vtt = buildShiftedWebVtt(cues, -89.5);

  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(!vtt.includes('Before seek point'), 'Cues ending prior to seek target should be omitted');
  assert.ok(vtt.includes('00:00:00.000 --> 00:00:03.000\nPartially overlapping seek point'));
  assert.ok(vtt.includes('00:00:10.500 --> 00:00:13.750\nAfter seek point'));
});

test('isSmartTvUserAgent and canDirectPlayNativeMp4 identify Hisense VIDAA and native MP4 streams safely', () => {
  assert.equal(
    isSmartTvUserAgent('Mozilla/5.0 (Linux; U; Android 9; Hisense SmartTV) AppleWebKit/537.36 VIDAA/6.0'),
    true
  );
  assert.equal(
    isSmartTvUserAgent('Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36'),
    true
  );
  assert.equal(
    isSmartTvUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'),
    false
  );

  assert.equal(
    canDirectPlayNativeMp4({ gcs_path: 'Movie.2024.1080p.mp4', video_codec: 'h264', audio_codec: 'aac' }),
    true
  );
  assert.equal(
    canDirectPlayNativeMp4({ gcs_path: 'Movie.2024.1080p.mp4', video_codec: 'h264', audio_codec: 'eac3' }),
    false,
    'Must not direct-play MP4 with Dolby EAC3 audio on Smart TV without AAC remux'
  );
  assert.equal(
    canDirectPlayNativeMp4({ gcs_path: 'Movie.2024.1080p.mkv', video_codec: 'h264', audio_codec: 'aac' }),
    false,
    'MKV containers require fMP4 remuxing'
  );
});
