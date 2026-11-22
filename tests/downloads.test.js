import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDownloadItem } from '../public/js/components.js';

test('renderDownloadItem renders downloading state with percentage and speed', () => {
  const dl = {
    id: 'test-dl-1',
    name: 'Sample.Movie.2024.1080p.mkv',
    source_type: 'torrent',
    status: 'downloading',
    status_text: 'Streaming to GCS...',
    progress: 45.6,
    speed: 5242880, // 5 MB/s
    downloaded_bytes: 4500000000,
    total_bytes: 10000000000,
    peers: 12,
  };

  const html = renderDownloadItem(dl);

  assert.ok(html.includes('dl-test-dl-1'), 'Contains download ID in HTML');
  assert.ok(html.includes('Sample.Movie.2024.1080p.mkv'), 'Contains movie name');
  assert.ok(html.includes('45.6%'), 'Contains formatted percentage');
  assert.ok(html.includes('5.0 MB/s'), 'Contains formatted speed');
  assert.ok(html.includes('4.19 GB / 9.31 GB'), 'Contains formatted GB sizes');
  assert.ok(html.includes('Peers: 12'), 'Contains peer count');
  assert.ok(html.includes('Streaming to GCS...'), 'Contains status text');
  assert.ok(html.includes('dl-pause-btn'), 'Contains pause button');
  assert.ok(html.includes('dl-delete-btn'), 'Contains delete button');
});

test('renderDownloadItem renders queued state correctly', () => {
  const dl = {
    id: 'test-dl-2',
    name: 'Upcoming.Episode.mkv',
    source_type: 'torrent',
    status: 'queued',
    status_text: 'Waiting in queue...',
    progress: 0,
    speed: 0,
    downloaded_bytes: 0,
    total_bytes: 0,
    peers: 0,
  };

  const html = renderDownloadItem(dl);

  assert.ok(html.includes('dl-test-dl-2'));
  assert.ok(html.includes('0%') || html.includes('0.0%'));
  assert.ok(html.includes('Waiting in queue...'));
});

test('renderDownloadItem renders completed state with green checkmark', () => {
  const dl = {
    id: 'test-dl-3',
    name: 'Finished.Show.mkv',
    source_type: 'torrent',
    status: 'completed',
    status_text: '',
    progress: 100,
    speed: 0,
    downloaded_bytes: 13409161325,
    total_bytes: 13409161325,
    peers: 0,
  };

  const html = renderDownloadItem(dl);

  assert.ok(html.includes('dl-test-dl-3'));
  assert.ok(html.includes('100%'));
  assert.ok(html.includes('✓ Saved to GCS'));
  assert.ok(html.includes('12.49 GB / 12.49 GB'));
});
