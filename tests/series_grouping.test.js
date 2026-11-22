import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSeriesKey, mediaDB } from '../server/db/database.js';
import { heuristicParseFilename } from '../server/services/aiTagger.js';

test('normalizeSeriesKey handles colons, dots, dashes, and casing', () => {
  const k1 = normalizeSeriesKey('Avatar: Seven Havens');
  const k2 = normalizeSeriesKey('Avatar.Seven.Havens');
  const k3 = normalizeSeriesKey('Avatar - Seven Havens');
  const k4 = normalizeSeriesKey('Avatar Seven Havens');

  assert.equal(k1, 'avatarsevenhavens');
  assert.equal(k2, 'avatarsevenhavens');
  assert.equal(k3, 'avatarsevenhavens');
  assert.equal(k4, 'avatarsevenhavens');
});

test('mediaDB groups and retrieves series with normalized keys', async () => {
  // Test grouping logic in-memory with isolated mock items (never connect to production MongoDB)
  await mediaDB.upsert({
    id: 'test-av-1',
    title: 'Avatar: Seven Havens S01E01: On the Horizon',
    type: 'series',
    series_name: 'Avatar: Seven Havens',
    season: 1,
    episode: 1,
    gcs_path: '__test_only_avatar_s01e01__.mkv',
    is_adult: false,
  });

  await mediaDB.upsert({
    id: 'test-av-6',
    title: 'Avatar Seven Havens S01E06: Night of the Afflicted',
    type: 'series',
    series_name: 'Avatar Seven Havens', // variation without colon
    season: 1,
    episode: 6,
    gcs_path: '__test_only_avatar_s01e06__.mkv',
    is_adult: false,
  });

  const grouped = mediaDB.getSeriesGrouped({ search: 'Avatar' });
  assert.equal(grouped.length, 1, 'Should group into exactly 1 Avatar series card');
  assert.equal(grouped[0].episodes_count, 2, 'Should count both episodes');
  assert.equal(grouped[0].title, 'Avatar: Seven Havens', 'Should keep richer title with colon');

  const seasonsData = mediaDB.getSeriesSeasons('Avatar: Seven Havens');
  assert.ok(seasonsData.seasons[1], 'Season 1 exists');
  assert.equal(seasonsData.seasons[1].length, 2, 'Both episodes retrieved');
  assert.equal(seasonsData.seasons[1][0].episode, 1);
  assert.equal(seasonsData.seasons[1][1].episode, 6);

  // Clean up test items
  await mediaDB.delete('test-av-1');
  await mediaDB.delete('test-av-6');
});

test('heuristicParseFilename parses spaced, hyphenated, dot-separated, and x-formatted episode codes cleanly', () => {
  const expanseS05E05 = heuristicParseFilename(
    'The EXPANSE - S05 E05 - Down and Out (1080p - AMZN WebRip).mp4'
  );
  assert.equal(expanseS05E05.type, 'series');
  assert.equal(expanseS05E05.series_name, 'The EXPANSE');
  assert.equal(expanseS05E05.season, 5);
  assert.equal(expanseS05E05.episode, 5);
  assert.equal(expanseS05E05.episode_title, 'Down and Out');
  assert.equal(expanseS05E05.title, 'The EXPANSE S05E05: Down and Out');
  assert.equal(expanseS05E05.is_adult, false);

  const expanseSpecial = heuristicParseFilename(
    'The Expanse S04E00 Kevin Smith Explains The Expanse  [1080p x265 q22 Joy].mkv'
  );
  assert.equal(expanseSpecial.type, 'series');
  assert.equal(expanseSpecial.series_name, 'The Expanse');
  assert.equal(expanseSpecial.season, 4);
  assert.equal(expanseSpecial.episode, 0);
  assert.equal(expanseSpecial.episode_title, 'Kevin Smith Explains The Expanse');
  assert.equal(expanseSpecial.title, 'The Expanse S04E00: Kevin Smith Explains The Expanse');

  const dotSeparated = heuristicParseFilename('Show.Name.S02.E08.Finale (Part 1) (1080p WEB-DL).mkv');
  assert.equal(dotSeparated.type, 'series');
  assert.equal(dotSeparated.series_name, 'Show Name');
  assert.equal(dotSeparated.season, 2);
  assert.equal(dotSeparated.episode, 8);
  assert.equal(dotSeparated.episode_title, 'Finale (Part 1)');
  assert.equal(dotSeparated.title, 'Show Name S02E08: Finale (Part 1)');

  const xFormatted = heuristicParseFilename('Classic Show - 1x04 - Episode Four 720p.mp4');
  assert.equal(xFormatted.type, 'series');
  assert.equal(xFormatted.series_name, 'Classic Show');
  assert.equal(xFormatted.season, 1);
  assert.equal(xFormatted.episode, 4);
  assert.equal(xFormatted.episode_title, 'Episode Four');
});
