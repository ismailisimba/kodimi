import test from 'node:test';
import assert from 'node:assert/strict';

import { mediaDB, getEffectiveAddedTime, toValidDate } from '../server/db/database.js';
import {
  buildRecentlyAddedFeed,
  sortMoviesList,
  renderCatalogCard,
} from '../public/js/components.js';

test('getEffectiveAddedTime is NaN-proof on undefined/invalid dates and prioritizes gcs_created_at', () => {
  assert.equal(toValidDate(undefined), null);
  assert.equal(toValidDate('not-a-valid-date'), null);

  const legacyUndated = { id: 'legacy-1', title: 'Succession - S01E01' };
  const withCreatedAt = {
    id: 'item-2',
    title: 'Older CreatedAt',
    created_at: '2026-01-10T00:00:00.000Z',
  };
  const withGcsCreated = {
    id: 'item-3',
    title: 'Newest GCS Upload',
    created_at: '2026-01-10T00:00:00.000Z',
    gcs_created_at: '2026-11-10T12:00:00.000Z',
  };

  assert.equal(getEffectiveAddedTime(legacyUndated), 0);
  assert.ok(getEffectiveAddedTime(withGcsCreated) > getEffectiveAddedTime(withCreatedAt));
  assert.ok(getEffectiveAddedTime(withCreatedAt) > getEffectiveAddedTime(legacyUndated));
});

test('mediaDB.upsert and mediaDB.getAll sort deterministically by recent, year, and title even with legacy undated items', async () => {
  const testIds = [
    'test-sort-legacy-succession',
    'test-sort-movie-older',
    'test-sort-movie-newest',
  ];

  try {
    await mediaDB.upsert({
      id: testIds[0],
      title: 'Succession - S01E01',
      series_name: 'Succession',
      type: 'series',
      season: 1,
      episode: 1,
      year: 2018,
      filename: 'Succession.S01E01.mkv',
      gcs_path: 'Succession/Succession.S01E01.mkv',
      gcs_created_at: new Date('2025-02-01T00:00:00.000Z'),
    });

    await mediaDB.upsert({
      id: testIds[1],
      title: 'Zeta Older Upload (2025 Release)',
      type: 'movie',
      year: 2025,
      filename: 'Zeta.2025.mp4',
      gcs_path: 'Movies/Zeta.2025.mp4',
      gcs_created_at: new Date('2026-03-01T00:00:00.000Z'),
    });

    await mediaDB.upsert({
      id: testIds[2],
      title: 'Alpha Newest Upload (1999 Classic)',
      type: 'movie',
      year: 1999,
      filename: 'Alpha.1999.mp4',
      gcs_path: 'Movies/Alpha.1999.mp4',
      gcs_created_at: new Date('2026-11-11T08:00:00.000Z'),
    });

    const recentAll = mediaDB.getAll({ sort: 'recent', limit: 200 }).filter((m) => testIds.includes(m.id));
    assert.deepEqual(
      recentAll.map((m) => m.id),
      [testIds[2], testIds[1], testIds[0]],
      'Newest GCS upload must rank above older movies and older Succession episodes'
    );

    const moviesByRecent = mediaDB.getAll({ type: 'movie', sort: 'recent', limit: 200 }).filter((m) => testIds.includes(m.id));
    assert.deepEqual(moviesByRecent.map((m) => m.id), [testIds[2], testIds[1]]);

    const moviesByYear = mediaDB.getAll({ type: 'movie', sort: 'year', limit: 200 }).filter((m) => testIds.includes(m.id));
    assert.deepEqual(moviesByYear.map((m) => m.id), [testIds[1], testIds[2]]);

    const moviesByTitle = mediaDB.getAll({ type: 'movie', sort: 'title', limit: 200 }).filter((m) => testIds.includes(m.id));
    assert.deepEqual(moviesByTitle.map((m) => m.id), [testIds[2], testIds[1]]);
  } finally {
    for (const id of testIds) {
      await mediaDB.delete(id);
    }
  }
});

test('buildRecentlyAddedFeed collapses multi-episode TV uploads into 1 Series card interleaved chronologically with Movies', () => {
  const mediaItems = [
    // 4 episodes of Succession uploaded months ago
    ...[1, 2, 3, 4].map((ep) => ({
      id: `succ-ep-${ep}`,
      type: 'series',
      series_name: 'Succession',
      title: `Succession - S01E0${ep}`,
      season: 1,
      episode: ep,
      gcs_created_at: '2025-05-01T10:00:00.000Z',
    })),
    // A movie uploaded yesterday
    {
      id: 'movie-dune-2',
      type: 'movie',
      title: 'Dune: Part Two',
      year: 2024,
      gcs_created_at: '2026-11-10T10:00:00.000Z',
    },
    // 6 episodes of Dark Matter uploaded today
    ...[1, 2, 3, 4, 5, 6].map((ep) => ({
      id: `dm-ep-${ep}`,
      type: 'series',
      series_name: 'Dark Matter',
      title: `Dark Matter - S01E0${ep}`,
      season: 1,
      episode: ep,
      series_plot: 'A physicist is abducted into an alternate version of his life.',
      gcs_created_at: `2026-11-11T0${ep}:00:00.000Z`,
    })),
  ];

  const seriesList = [
    {
      id: 'series-darkmatter',
      type: 'series',
      series_name: 'Dark Matter',
      title: 'Dark Matter',
      seasons_count: 1,
      episodes_count: 6,
      sample_media_id: 'dm-ep-1',
      gcs_created_at: '2026-11-11T06:00:00.000Z',
    },
    {
      id: 'series-succession',
      type: 'series',
      series_name: 'Succession',
      title: 'Succession',
      seasons_count: 1,
      episodes_count: 4,
      sample_media_id: 'succ-ep-1',
      gcs_created_at: '2025-05-01T10:00:00.000Z',
    },
  ];

  const feed = buildRecentlyAddedFeed(mediaItems, seriesList, 18);
  assert.equal(feed.length, 3, 'Should collapse 6 Dark Matter eps + 4 Succession eps + 1 Movie into exactly 3 cards');
  assert.equal(feed[0].title, 'Dark Matter');
  assert.equal(feed[0].is_series_group, true);
  assert.equal(feed[1].title, 'Dune: Part Two');
  assert.equal(feed[2].title, 'Succession');
  assert.equal(feed[2].is_series_group, true);

  // Verify renderCatalogCard delegates series groups to .series-card and movies to regular .media-card
  const seriesHtml = renderCatalogCard(feed[0]);
  const movieHtml = renderCatalogCard(feed[1]);
  assert.ok(seriesHtml.includes('series-card') && seriesHtml.includes('data-series-name="Dark Matter"'));
  assert.ok(!movieHtml.includes('series-card') && movieHtml.includes('data-id="movie-dune-2"'));

  // Verify sortMoviesList orders by newest GCS upload by default
  const sortedMovies = sortMoviesList([
    { id: 'm1', title: 'Older Upload', year: 2026, gcs_created_at: '2026-01-01T00:00:00Z' },
    { id: 'm2', title: 'Newer Upload', year: 2020, gcs_created_at: '2026-11-09T00:00:00Z' },
  ]);
  assert.deepEqual(sortedMovies.map((m) => m.id), ['m2', 'm1']);
});
