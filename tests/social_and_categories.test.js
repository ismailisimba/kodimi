import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSocialPlatform,
  resolveYtDlpRunner,
  sanitizeFilenameSegment,
} from '../server/services/socialDownloader.js';
import { applyCategoryOverride } from '../server/services/aiTagger.js';
import { mediaDB } from '../server/db/database.js';

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
