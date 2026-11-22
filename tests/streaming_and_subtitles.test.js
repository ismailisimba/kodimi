import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';

import {
  resolveTargetCodec,
  computeEffectiveTranscodePlan,
  buildOriginalRemuxOptions,
  convertSubtitleToWebVTT,
  registerActiveStream,
  getActiveStreamCount,
} from '../server/services/transcoder.js';
import { mediaDB } from '../server/db/database.js';
import { parseSubtitleText, renderSafeSubtitleHtml } from '../public/js/player.js';

const ALL_ENCODERS = { av1: true, hevc: true, h264: true };

test('resolveTargetCodec negotiates AV1 -> HEVC -> H.264 with clean server fallback', () => {
  assert.equal(resolveTargetCodec('av1', { av1: true, hevc: true, h264: true }), 'av1');
  assert.equal(resolveTargetCodec('av1', { av1: false, hevc: true, h264: true }), 'hevc');
  assert.equal(resolveTargetCodec('av1', { av1: false, hevc: false, h264: true }), 'h264');
  assert.equal(resolveTargetCodec('hevc', { av1: true, hevc: true, h264: true }), 'hevc');
  assert.equal(resolveTargetCodec('x265', { av1: true, hevc: false, h264: true }), 'h264');
  assert.equal(resolveTargetCodec('h264', ALL_ENCODERS), 'h264');
});

test('computeEffectiveTranscodePlan clamps downscaled 720p below compact 180MB 1080p source and Smart-Remuxes 1080p-low', () => {
  // 180 MB, 24-minute (1440s) 1080p episode => ~1,049 kbps total
  const compactAvatarEpisode = {
    id: 'test-avatar-compact',
    filename: 'Avatar.S01E01.1080p.x265.mkv',
    gcs_path: 'Avatar.S01E01.1080p.x265.mkv',
    size_bytes: 180 * 1024 * 1024,
    duration: 24 * 60,
  };

  // 1. 720p must NEVER inflate above the ~1,049 kbps source (even on H.264 fallback!)
  const plan720Av1 = computeEffectiveTranscodePlan(compactAvatarEpisode, '720p', 'av1', {
    encoders: ALL_ENCODERS,
    clientSupportsAv1: true,
    clientSupportsHevc: true,
  });
  assert.ok(plan720Av1.sourceTotalKbps >= 1000 && plan720Av1.sourceTotalKbps <= 1100);
  assert.equal(plan720Av1.codec, 'av1');
  assert.ok(
    plan720Av1.effectiveMaxrateKbps < plan720Av1.sourceTotalKbps - 200,
    `Expected 720p maxrate (${plan720Av1.effectiveMaxrateKbps}k) to be strictly lower than compact 1080p source (${plan720Av1.sourceTotalKbps}k)`
  );

  const plan720H264 = computeEffectiveTranscodePlan(compactAvatarEpisode, '720p', 'h264', {
    encoders: ALL_ENCODERS,
  });
  assert.equal(plan720H264.codec, 'h264');
  assert.ok(
    plan720H264.effectiveMaxrateKbps < plan720H264.sourceTotalKbps - 200,
    `Even on H.264 fallback, 720p maxrate (${plan720H264.effectiveMaxrateKbps}k) must stay below compact source (${plan720H264.sourceTotalKbps}k)`
  );

  // 2. 1080p-low Smart Remuxes when source is already compact (<= 1450 kbps) AND client supports HEVC
  const plan1080LowSmart = computeEffectiveTranscodePlan(compactAvatarEpisode, '1080p-low', 'av1', {
    encoders: ALL_ENCODERS,
    clientSupportsAv1: true,
    clientSupportsHevc: true,
  });
  assert.equal(plan1080LowSmart.shouldSmartRemux, true, 'Should smart-remux already-optimized HEVC 1080p source');

  // 3. 1080p-low transcodes when source is HEVC but client only supports H.264
  const plan1080LowNoHevc = computeEffectiveTranscodePlan(compactAvatarEpisode, '1080p-low', 'h264', {
    encoders: ALL_ENCODERS,
    clientSupportsAv1: false,
    clientSupportsHevc: false,
  });
  assert.equal(plan1080LowNoHevc.shouldSmartRemux, false, 'Must transcode HEVC source when client lacks HEVC decode');
});

test('computeEffectiveTranscodePlan compresses bloated 2.5GB 1080p source in 1080p-low mode', () => {
  // 2.5 GB, 45-minute (2700s) 1080p episode => ~7,953 kbps
  const bloatedEpisode = {
    id: 'test-bloated-1080p',
    filename: 'Show.S01E02.1080p.WEB-DL.H264.mkv',
    gcs_path: 'Show.S01E02.1080p.WEB-DL.H264.mkv',
    size_bytes: Math.round(2.5 * 1024 * 1024 * 1024),
    duration: 45 * 60,
  };

  const planAv1 = computeEffectiveTranscodePlan(bloatedEpisode, '1080p-low', 'av1', {
    encoders: ALL_ENCODERS,
    clientSupportsAv1: true,
  });
  assert.equal(planAv1.shouldSmartRemux, false);
  assert.equal(planAv1.codec, 'av1');
  assert.equal(planAv1.effectiveMaxrateKbps, 1150);

  const planHevc = computeEffectiveTranscodePlan(bloatedEpisode, '1080p-low', 'hevc', {
    encoders: ALL_ENCODERS,
    clientSupportsHevc: true,
  });
  assert.equal(planHevc.shouldSmartRemux, false);
  assert.equal(planHevc.codec, 'hevc');
  assert.equal(planHevc.effectiveMaxrateKbps, 1250);
});

test('convertSubtitleToWebVTT and parseSubtitleText handle .SRT, .ASS, late-episode cues, and overlapping dialogue', () => {
  // 1. SubRip (.srt) with comma decimals, ASS positioning overrides, and >48 minute timestamps
  const sampleSrt = `\uFEFF1
00:00:10,000 --> 00:00:14,000
{\\an8}[Episode 1: The Awakening]

2
00:00:11,500 --> 00:00:13,500
<i>Long ago, the four nations lived together.</i>

3
00:48:15,250 --> 00:48:19,800
Still visible at minute 48 without truncation!
`;

  const vttFromSrt = convertSubtitleToWebVTT(sampleSrt, 'episode1.srt');
  assert.ok(vttFromSrt.startsWith('WEBVTT\n\n'));
  assert.ok(vttFromSrt.includes('00:00:10.000 --> 00:00:14.000'));
  assert.ok(vttFromSrt.includes('00:48:15.250 --> 00:48:19.800'));
  assert.ok(!vttFromSrt.includes('{\\an8}'), 'Should strip raw ASS positioning tags');

  const parsedSrtCues = parseSubtitleText(vttFromSrt, 'episode1.vtt');
  assert.equal(parsedSrtCues.length, 3);
  assert.equal(parsedSrtCues[2].start, 48 * 60 + 15.25);
  assert.equal(parsedSrtCues[2].text, 'Still visible at minute 48 without truncation!');

  // Verify simultaneous overlapping cues at t = 12.0s
  const activeAt12s = parsedSrtCues.filter((c) => 12.0 >= c.start && 12.0 <= c.end);
  assert.equal(activeAt12s.length, 2, 'Both sign and spoken dialogue cues should be active simultaneously at t=12s');

  // 2. SubStation Alpha (.ass) with commas inside dialogue, \N line breaks, italics, and vector drawings
  const sampleAss = `[Script Info]
Title: Avatar Styled Subtitles
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.10,0:00:08.45,Default,Katara,0,0,0,,Wait, Sokka!\\N{\\i1}Look over there, right now!{\\i0}
Dialogue: 0,0:00:06.00,0:00:07.00,Drawing,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}
`;

  const vttFromAss = convertSubtitleToWebVTT(sampleAss, 'avatar.ass');
  assert.ok(vttFromAss.includes('00:00:05.100 --> 00:00:08.450'));
  assert.ok(vttFromAss.includes('Wait, Sokka!\n<i>Look over there, right now!</i>'));
  assert.ok(!vttFromAss.includes('m 0 0 l 100'), 'Should exclude ASS vector drawing shapes');

  // Direct client-side .ass parsing should match
  const directAssCues = parseSubtitleText(sampleAss, 'avatar.ass');
  assert.equal(directAssCues.length, 1);
  assert.equal(directAssCues[0].start, 5.1);
  assert.equal(directAssCues[0].end, 8.45);
  assert.equal(directAssCues[0].text, 'Wait, Sokka!\n<i>Look over there, right now!</i>');
});

test('renderSafeSubtitleHtml preserves <i>, <b>, <u> while escaping XSS payloads', () => {
  const dirty = '<i>Hello</i> & <b>world</b> <img src=x onerror="alert(1)"><script>evil()</script>';
  const safe = renderSafeSubtitleHtml(dirty);
  assert.equal(
    safe,
    '<i>Hello</i> &amp; <b>world</b> &lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;evil()&lt;/script&gt;'
  );
});

test('registerActiveStream preempts prior FFmpeg processes on rapid seeks and cleans up on res close (zero 429 leak)', () => {
  const createMockCommand = () => {
    const emitter = new EventEmitter();
    emitter.killedSignals = [];
    emitter.kill = (sig) => {
      emitter.killedSignals.push(sig);
    };
    return emitter;
  };

  const sessionKey = 'test_seek_session_1';
  const commands = [];
  const responses = [];

  // Simulate 5 rapid seeks on the same playback session
  for (let i = 0; i < 5; i++) {
    const cmd = createMockCommand();
    const res = new EventEmitter();
    commands.push(cmd);
    responses.push(res);
    registerActiveStream(sessionKey, cmd, res);

    // At any point during rapid seeking, at most 1 active stream may exist for this session
    assert.equal(getActiveStreamCount(), 1, `Seek #${i + 1} should preempt prior stream so active count stays 1`);
  }

  // First 4 commands must have immediately received SIGKILL
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(commands[i].killedSignals, ['SIGKILL'], `Command #${i} should be killed on subsequent seek`);
  }
  assert.equal(commands[4].killedSignals.length, 0, 'Latest command remains alive while streaming');

  // When client closes the active HTTP response, FFmpeg is killed immediately and count drops to 0
  responses[4].emit('close');
  assert.deepEqual(commands[4].killedSignals, ['SIGKILL']);
  assert.equal(getActiveStreamCount(), 0);
});

test('buildOriginalRemuxOptions maintains A/V PTS lip-sync at t=0 and mid-GOP seek t=2.7s on HEVC+EAC3 MKV', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodimi-avsync-'));
  const srcMkv = path.join(tmpDir, 'hevc_bframes_eac3.mkv');
  const outStartMp4 = path.join(tmpDir, 'remux_t0.mp4');
  const outSeekMp4 = path.join(tmpDir, 'remux_seek.mp4');

  try {
    // Generate a 6-second MKV with HEVC B-pyramid frames (-bf 4 -g 48) and EAC3 audio
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x180:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
        '-c:v', 'libx265',
        '-preset', 'ultrafast',
        '-x265-params', 'bframes=4:keyint=48:min-keyint=48:scenecut=0:log-level=none',
        '-c:a', 'eac3',
        '-b:a', '192k',
        srcMkv,
      ],
      { timeout: 30000 }
    );

    const probeFirstTimestamps = (mp4File) => {
      const jsonRaw = execFileSync(
        'ffprobe',
        [
          '-v', 'error',
          '-show_streams',
          '-show_packets',
          '-of', 'json',
          mp4File,
        ],
        { encoding: 'utf8', timeout: 15000 }
      );
      const parsed = JSON.parse(jsonRaw);
      const vStream = parsed.streams.find((s) => s.codec_type === 'video');
      const vPkt = parsed.packets.find((p) => p.codec_type === 'video' && p.pts_time !== undefined);
      const aPkt = parsed.packets.find((p) => p.codec_type === 'audio' && p.pts_time !== undefined);
      return {
        videoTag: vStream?.codec_tag_string,
        vPts: parseFloat(vPkt?.pts_time ?? 'NaN'),
        aPts: parseFloat(aPkt?.pts_time ?? 'NaN'),
      };
    };

    // 1. Remux from t = 0
    const opts0 = buildOriginalRemuxOptions(0, { isSourceHevc: true });
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        ...opts0.inputOptions,
        '-i', srcMkv,
        ...opts0.outputOptions,
        '-f', 'mp4',
        outStartMp4,
      ],
      { timeout: 20000 }
    );

    const sync0 = probeFirstTimestamps(outStartMp4);
    assert.equal(sync0.videoTag, 'hvc1', 'HEVC fMP4 remux must tag video stream as hvc1 for browser compatibility');
    assert.ok(Math.abs(sync0.vPts - sync0.aPts) < 0.25, `t=0 A/V PTS delta too large: v=${sync0.vPts}s, a=${sync0.aPts}s`);

    // 2. Remux from mid-GOP seek t = 2.7s (between keyframes at 0.0s, 2.0s, 4.0s)
    const optsSeek = buildOriginalRemuxOptions(2.7, { isSourceHevc: true });
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        ...optsSeek.inputOptions,
        '-ss', '2.7',
        '-i', srcMkv,
        ...optsSeek.outputOptions,
        '-f', 'mp4',
        outSeekMp4,
      ],
      { timeout: 20000 }
    );

    const syncSeek = probeFirstTimestamps(outSeekMp4);
    assert.ok(
      Math.abs(syncSeek.vPts - syncSeek.aPts) < 0.25,
      `Mid-GOP seek A/V PTS delta too large: v=${syncSeek.vPts}s, a=${syncSeek.aPts}s`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('mediaDB.upsert preserves duration, bitrate_kbps, and custom_subtitles across partial metadata updates', async () => {
  const testId = '__test_preserve_subs_and_bitrate__';
  try {
    await mediaDB.upsert({
      id: testId,
      title: 'Test Preservation Movie',
      type: 'movie',
      gcs_path: '__test_only_preserve__.mkv',
      duration: 5400,
      bitrate_kbps: 1120,
      custom_subtitles: [
        {
          id: 'sub_1',
          label: 'English (Custom)',
          language: 'en',
          gcs_path: '.subtitles/__test_sub_1.vtt',
          format: 'vtt',
        },
      ],
    });

    // Simulate AI re-tagging upsert that omits duration, bitrate_kbps, and custom_subtitles
    await mediaDB.upsert({
      id: testId,
      title: 'Test Preservation Movie (Retagged)',
      type: 'movie',
      gcs_path: '__test_only_preserve__.mkv',
      genres: ['Sci-Fi'],
    });

    const saved = mediaDB.getById(testId);
    assert.equal(saved.title, 'Test Preservation Movie (Retagged)');
    assert.equal(saved.duration, 5400);
    assert.equal(saved.bitrate_kbps, 1120);
    assert.equal(saved.custom_subtitles.length, 1);
    assert.equal(saved.custom_subtitles[0].id, 'sub_1');
  } finally {
    await mediaDB.delete(testId);
  }
});

test('fluent-ffmpeg SVT-AV1 capped-CRF fMP4 pipe downscales 1080p->720p and prevents upscaling 360p->720p', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodimi-av1pipe-'));
  const src360 = path.join(tmpDir, 'src_360p.mkv');
  const outPipeMp4 = path.join(tmpDir, 'piped_av1.mp4');

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=1.5:size=640x360:rate=24',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5:sample_rate=48000',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        src360,
      ],
      { timeout: 15000 }
    );

    const plan = computeEffectiveTranscodePlan(
      { size_bytes: 50 * 1024 * 1024, duration: 120 },
      '720p',
      'av1',
      { encoders: ALL_ENCODERS, clientSupportsAv1: true }
    );

    await new Promise((resolve, reject) => {
      const sink = fs.createWriteStream(outPipeMp4);
      const pass = new PassThrough();
      pass.pipe(sink);

      const cmd = ffmpeg(src360)
        .inputOptions(['-probesize', '3000000', '-analyzeduration', '3000000', '-fflags', '+genpts'])
        .format('mp4')
        .outputOptions([
          '-map', '0:v:0',
          '-map', '0:a:0?',
          '-vf', `scale=-2:min(${plan.profile.height}\\,trunc(ih/2)*2)`,
          '-c:v', 'libsvtav1',
          '-preset', '10',
          '-crf', String(plan.crf),
          '-maxrate', `${plan.effectiveMaxrateKbps}k`,
          '-bufsize', `${plan.bufsizeKbps}k`,
          '-g', '120',
          '-pix_fmt', 'yuv420p',
          '-c:a', 'aac',
          '-b:a', plan.audioBitrate,
          '-ar', '48000',
          '-ac', '2',
          '-af', 'aresample=async=1',
          '-threads', '0',
          '-avoid_negative_ts', 'make_zero',
          '-max_muxing_queue_size', '2048',
          '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
          '-flush_packets', '1',
        ]);

      cmd.on('error', reject);
      sink.on('finish', resolve);
      sink.on('error', reject);
      cmd.pipe(pass, { end: true });
    });

    const probeRaw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-of', 'json', outPipeMp4],
      { encoding: 'utf8', timeout: 10000 }
    );
    const streams = JSON.parse(probeRaw).streams;
    const vStream = streams.find((s) => s.codec_type === 'video');
    const aStream = streams.find((s) => s.codec_type === 'audio');

    assert.equal(vStream.codec_name, 'av1');
    assert.equal(vStream.height, 360, '360p source requested at 720p must stay 360p (never waste bandwidth upscaling)');
    assert.equal(aStream.codec_name, 'aac');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

