import test from 'node:test';
import assert from 'node:assert/strict';

import {
  heuristicParseFilename,
  isPlaceholderOrGenericPlot,
  extractJsonObject,
  MEDIA_METADATA_JSON_SCHEMA,
} from '../server/services/aiTagger.js';
import { mediaDB } from '../server/db/database.js';

test('heuristicParseFilename preserves numeric movie titles and extracts release years accurately', () => {
  const m1917WithYear = heuristicParseFilename('1917.2019.1080p.BluRay.x264.mp4');
  assert.equal(m1917WithYear.title, '1917');
  assert.equal(m1917WithYear.year, 2019);
  assert.equal(m1917WithYear.type, 'movie');

  const m1917NoYear = heuristicParseFilename('1917.1080p.WEBRip.x265.mp4');
  assert.equal(m1917NoYear.title, '1917');
  assert.equal(m1917NoYear.year, null);

  const bladeRunner = heuristicParseFilename('Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv');
  assert.equal(bladeRunner.title, 'Blade Runner 2049');
  assert.equal(bladeRunner.year, 2017);

  const spaceOdyssey = heuristicParseFilename('2001.A.Space.Odyssey.1968.1080p.BluRay.x264.mkv');
  assert.equal(spaceOdyssey.title, '2001 A Space Odyssey');
  assert.equal(spaceOdyssey.year, 1968);

  const darkMatterEp = heuristicParseFilename('Dark.Matter.2024.S01E03.The.Box.1080p.ATVP.WEB-DL.mkv');
  assert.equal(darkMatterEp.type, 'series');
  assert.equal(darkMatterEp.series_name, 'Dark Matter');
  assert.equal(darkMatterEp.year, 2024);
  assert.equal(darkMatterEp.season, 1);
  assert.equal(darkMatterEp.episode, 3);

  const wreckingCrew = heuristicParseFilename('The.Wrecking.Crew.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264.mkv');
  assert.equal(wreckingCrew.title, 'The Wrecking Crew');
  assert.equal(wreckingCrew.year, 2026);
  assert.equal(wreckingCrew.type, 'movie');
});

test('isPlaceholderOrGenericPlot detects generic fallback synopses while preserving authentic plots', () => {
  assert.equal(isPlaceholderOrGenericPlot(''), true);
  assert.equal(
    isPlaceholderOrGenericPlot('Enjoy The Wrecking Crew streaming on your personal Kodimi cloud platform.'),
    true
  );
  assert.equal(
    isPlaceholderOrGenericPlot('Enjoy Mobland S01E01 streaming in 1080p on your personal Kodimi media center.'),
    true
  );
  assert.equal(
    isPlaceholderOrGenericPlot('Watch Dark Matter - S01E01 in high definition on Kodimi.'),
    true
  );
  assert.equal(
    isPlaceholderOrGenericPlot(
      'Two estranged half-brothers in Hawaii reunite after their father dies mysteriously, uncovering a sprawling conspiracy.'
    ),
    false
  );
});

test('MEDIA_METADATA_JSON_SCHEMA includes documentary and others media categories', () => {
  const allowedTypes = MEDIA_METADATA_JSON_SCHEMA.properties.type.enum;
  assert.deepEqual(allowedTypes, ['movie', 'series', 'documentary', 'others']);
});

test('extractJsonObject parses grounded responses with markdown fences or surrounding search preamble', () => {
  const clean = extractJsonObject('{"title":"1917","year":2019,"plot":"Two British soldiers race against time."}');
  assert.equal(clean.title, '1917');
  assert.equal(clean.year, 2019);

  const fencedWithPreamble = extractJsonObject(`Based on Google Search results for the 2024 Apple TV+ series:
\`\`\`json
{
  "title": "Dark Matter - S01E01: Are You Happy in Your Life?",
  "series_name": "Dark Matter",
  "type": "series",
  "year": 2024,
  "series_plot": "Chicago physicist Jason Dessen is abducted into an alternate version of his life where he never married his wife Daniela.",
  "plot": "Jason celebrates a friend's prestigious award before a masked stranger abducts him on his walk home, {",
  "genres": ["Sci-Fi", "Thriller"]
}
\`\`\`
Sources: Apple TV+`);

  assert.equal(fencedWithPreamble.series_name, 'Dark Matter');
  assert.equal(fencedWithPreamble.year, 2024);
  assert.ok(fencedWithPreamble.series_plot.includes('Jason Dessen'));
  assert.ok(fencedWithPreamble.plot.includes('masked stranger'));
});

test('mediaDB separates overarching series_plot from individual episode plot in Series views', async () => {
  const ep1Id = 'test-series-plot-ep1';
  const ep2Id = 'test-series-plot-ep2';

  try {
    await mediaDB.upsert({
      id: ep1Id,
      type: 'series',
      series_name: 'Test Chronos Show',
      title: 'Test Chronos Show - S01E01: Pilot',
      season: 1,
      episode: 1,
      year: 2025,
      series_plot: 'Overarching premise of Test Chronos Show across all seasons.',
      plot: 'Episode 1 specific plot: Maya discovers the chronos anomaly in the lab.',
      genres: ['Sci-Fi'],
      filename: 'Test.Chronos.Show.S01E01.mkv',
      gcs_path: 'Shows/Test.Chronos.Show.S01E01.mkv',
    });

    await mediaDB.upsert({
      id: ep2Id,
      type: 'series',
      series_name: 'Test Chronos Show',
      title: 'Test Chronos Show - S01E02: Paradox',
      season: 1,
      episode: 2,
      year: 2025,
      series_plot: 'Overarching premise of Test Chronos Show across all seasons.',
      plot: 'Episode 2 specific plot: The timeline fractures after the first jump.',
      genres: ['Sci-Fi'],
      filename: 'Test.Chronos.Show.S01E02.mkv',
      gcs_path: 'Shows/Test.Chronos.Show.S01E02.mkv',
    });

    const grouped = mediaDB.getSeriesGrouped().find((s) => s.series_name === 'Test Chronos Show');
    assert.ok(grouped);
    assert.equal(
      grouped.plot,
      'Overarching premise of Test Chronos Show across all seasons.',
      'Series card/hero must use series_plot instead of Episode 1 plot'
    );

    const seasonsData = mediaDB.getSeriesSeasons('Test Chronos Show');
    assert.ok(seasonsData);
    assert.equal(
      seasonsData.series.plot,
      'Overarching premise of Test Chronos Show across all seasons.'
    );
    assert.equal(
      seasonsData.seasons[1][0].plot,
      'Episode 1 specific plot: Maya discovers the chronos anomaly in the lab.'
    );
    assert.equal(
      seasonsData.seasons[1][1].plot,
      'Episode 2 specific plot: The timeline fractures after the first jump.'
    );
  } finally {
    await mediaDB.delete(ep1Id);
    await mediaDB.delete(ep2Id);
  }
});
