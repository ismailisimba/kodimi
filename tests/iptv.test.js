import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURATED_CHANNELS,
  initIptvService,
  getCategories,
  getChannels,
  getChannelSchedule,
  parseM3u,
  rewriteM3u8,
  assertSafePublicUrl,
  isPrivateIpAddress,
} from '../server/services/iptvService.js';

// Prevent background reachability sweeps from holding open sockets during unit tests
process.env.NODE_ENV = 'test';

test('SSRF guard blocks private IPv4/IPv6, cloud metadata endpoints, and non-HTTP schemes', async () => {
  assert.equal(isPrivateIpAddress('127.0.0.1'), true);
  assert.equal(isPrivateIpAddress('10.20.30.40'), true);
  assert.equal(isPrivateIpAddress('169.254.169.254'), true);
  assert.equal(isPrivateIpAddress('192.168.1.5'), true);
  assert.equal(isPrivateIpAddress('::1'), true);
  assert.equal(isPrivateIpAddress('fe80::1'), true);
  assert.equal(isPrivateIpAddress('8.8.8.8'), false);

  const blockedUrls = [
    'http://127.0.0.1:8080/api/auth/me',
    'http://localhost:3000/secret',
    'http://169.254.169.254/computeMetadata/v1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://10.0.0.5/internal.m3u8',
    'file:///etc/passwd',
    'ftp://example.com/stream.m3u8',
  ];

  for (const url of blockedUrls) {
    await assert.rejects(
      () => assertSafePublicUrl(url, { skipDnsLookup: true }),
      `Expected SSRF guard to block ${url}`
    );
  }

  const safe = await assertSafePublicUrl('https://cdn.example.com/live/master.m3u8', { skipDnsLookup: true });
  assert.equal(safe, 'https://cdn.example.com/live/master.m3u8');
});

test('parseM3u extracts #EXTVLCOPT headers and filters geo-blocked, not-24/7, DASH, and dead CDN hosts', () => {
  const sampleM3u = `#EXTM3U
#EXTINF:-1 tvg-id="GoodNews.us@HD" tvg-logo="https://img.example.com/logo.png" group-title="News",Good News HD
#EXTVLCOPT:http-referrer=https://news.example.com/
#EXTVLCOPT:http-user-agent=KodimiCustomUA/1.0
https://stream.goodnews.example/live/master.m3u8
#EXTINF:-1 tvg-id="GeoBlocked.uk" group-title="News",Geo News [Geo-blocked]
https://stream.geoblocked.example/live.m3u8
#EXTINF:-1 tvg-id="PartTime.us" group-title="Sports",Event Feed [Not 24/7]
https://stream.parttime.example/live.m3u8
#EXTINF:-1 tvg-id="DashFeed.us" group-title="Movies",Dash Channel
https://stream.dash.example/manifest.mpd
#EXTINF:-1 tvg-id="DeadCdn.us" group-title="Movies",Blocked CDN Feed
https://edge.primetv.cc.cd/live/channel/123/master.m3u8
`;

  const parsed = parseM3u(sampleM3u, 'General');
  assert.equal(parsed.length, 1, 'Only clean 24/7 HLS channel should survive filtering');
  assert.equal(parsed[0].name, 'Good News HD');
  assert.equal(parsed[0].country, 'United States', '@HD suffix should not break country detection');
  assert.equal(parsed[0].headers?.referer, 'https://news.example.com/');
  assert.equal(parsed[0].headers?.userAgent, 'KodimiCustomUA/1.0');
  assert.equal(parsed[0].requiresProxy, true, 'Channels with custom headers should mark requiresProxy=true');
});

test('rewriteM3u8 resolves relative URLs against post-redirect finalUrl and preserves channelId & auth token', () => {
  const manifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"
#EXT-X-STREAM-INF:BANDWIDTH=1200000
chunks/720p.m3u8
`;

  const rewritten = rewriteM3u8(manifest, 'https://edge-eu.cdn.example/live/v2/master.m3u8', {
    channelId: 'curated-al-jazeera-en',
    token: 'jwt-test-token',
  });

  assert.ok(
    rewritten.includes(encodeURIComponent('https://edge-eu.cdn.example/live/v2/chunks/720p.m3u8')),
    'Relative variant URL must resolve against redirected baseUrl'
  );
  assert.ok(
    rewritten.includes(encodeURIComponent('https://edge-eu.cdn.example/live/v2/keys/enc.key')),
    'Relative AES key URI must resolve against redirected baseUrl'
  );
  assert.ok(rewritten.includes('channelId=curated-al-jazeera-en'), 'Must forward channelId for header lookup');
  assert.ok(rewritten.includes('token=jwt-test-token'), 'Must forward auth token for authenticated proxy segments');
});

test('Live TV concurrent cold-start initialization covers 6 countries / 3 continents and all categories', async () => {
  await initIptvService({ skipBackgroundProbe: true });

  const [catsRes, channelsRes] = await Promise.all([
    getCategories(),
    getChannels({ limit: 120 }),
  ]);

  assert.ok(CURATED_CHANNELS.length >= 20, `Expected >=20 verified curated channels, got ${CURATED_CHANNELS.length}`);
  assert.ok(catsRes.totalChannels > 100, `Expected >100 totalChannels on cold start, got ${catsRes.totalChannels}`);
  assert.ok(channelsRes.total > 100, `Expected >100 channels.total on concurrent cold start, got ${channelsRes.total}`);
  assert.equal(channelsRes.items.length, 120, 'Should return full page of 120 channels on cold start');

  // Verify every category filter returns channels
  for (const cat of catsRes.categories) {
    const res = await getChannels({ category: cat.id, limit: 20 });
    assert.ok(res.total > 0, `Category "${cat.id}" (${cat.name}) should return >0 channels, got ${res.total}`);
    assert.ok(res.items.length > 0, `Category "${cat.id}" items should not be empty`);
  }

  // Verify 6 countries / 3 continents + global ('us', 'ca', 'uk', 'de', 'au', 'jp', 'global')
  const expectedCountryIds = ['us', 'ca', 'uk', 'de', 'au', 'jp', 'global'];
  for (const cid of expectedCountryIds) {
    const country = catsRes.countries.find((c) => c.id === cid);
    assert.ok(country, `Expected country "${cid}" in getCategories()`);
    assert.ok(country.count > 0, `Country "${cid}" (${country.name}) count should be >0, got ${country.count}`);
    const res = await getChannels({ country: cid, limit: 20 });
    assert.equal(res.total, country.count, `Country "${cid}" total should match reported category count`);
    assert.ok(res.items.length > 0, `Country "${cid}" items should not be empty`);
  }

  // Verify verifiedOnly mode returns curated/verified channels immediately
  const verifiedRes = await getChannels({ verifiedOnly: true, limit: 50 });
  assert.ok(verifiedRes.total >= CURATED_CHANNELS.length, 'verifiedOnly should include all curated verified channels');

  // Verify 24h EPG schedule generation
  const firstChannel = channelsRes.items[0];
  const scheduleData = await getChannelSchedule(firstChannel.id);
  assert.ok(scheduleData, 'Schedule data should be returned for channel');
  assert.ok(scheduleData.currentProgram, 'Current program should be present');
  assert.ok(Array.isArray(scheduleData.schedule) && scheduleData.schedule.length > 0, '24h schedule array should be populated');
});
