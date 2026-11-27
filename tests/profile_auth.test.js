import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import EventEmitter from 'node:events';
import { config } from '../server/config/env.js';
import {
  profilesDB,
  lockoutsDB,
  resetRequestsDB,
  sanitizeProfile,
  LOCKOUT_DURATION_MS,
} from '../server/db/database.js';
import {
  authenticateByCode,
  generateToken,
  requireAuth,
  requireOwner,
  isVaultAuthorized,
  createAuthRateLimiter,
} from '../server/services/auth.js';
import authRoutes from '../server/routes/auth.js';
import profileRoutes from '../server/routes/profiles.js';
import { renderResetRequestCard } from '../public/js/components.js';

function createMockRes() {
  const emitter = new EventEmitter();
  const headers = {};
  const res = Object.assign(emitter, {
    statusCode: 200,
    body: null,
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.emit('finish');
      return this;
    },
  });
  return res;
}

test('Per-profile code authentication hides passcodes, enforces uniqueness (409), and locks profiles without codes', async () => {
  const owner = await profilesDB.create({
    id: 'test-owner-1',
    name: 'Test Owner',
    role: 'owner',
    passcode: 'owner-secret-9999',
  });
  const member = await profilesDB.create({
    id: 'test-member-1',
    name: 'Test Member',
    role: 'member',
    passcode: 'member-code-1234',
  });
  const locked = await profilesDB.create({
    id: 'test-locked-1',
    name: 'Locked Guest',
    role: 'member',
  });

  try {
    // 1. Passcode hashes AND fingerprints must NEVER leak through sanitized responses
    assert.equal(owner.passcode_hash, undefined);
    assert.equal(owner.passcode_fingerprint, undefined);
    assert.equal(owner.has_passcode, true);
    assert.equal(owner.role, 'owner');
    assert.equal(member.passcode_hash, undefined);
    assert.equal(member.passcode_fingerprint, undefined);
    assert.equal(member.has_passcode, true);
    assert.equal(member.role, 'member');
    assert.equal(locked.has_passcode, false);

    const publicList = profilesDB.getAll();
    assert.ok(publicList.every((p) => p.passcode_hash === undefined && p.passcode_fingerprint === undefined));
    const sanitizedOwner = sanitizeProfile(profilesDB.getRawById(owner.id));
    assert.equal(sanitizedOwner.passcode_hash, undefined);
    assert.equal(sanitizedOwner.passcode_fingerprint, undefined);

    // 1b. Overlong passcodes (>72 UTF-8 bytes) rejected to avoid bcrypt truncation collisions
    await assert.rejects(
      () =>
        profilesDB.create({
          id: 'test-overlong-1',
          name: 'Overlong Code User',
          passcode: 'a'.repeat(73),
        }),
      (err) => err.statusCode === 400
    );

    // 2. Duplicate login code rejected with 409 Conflict
    await assert.rejects(
      () =>
        profilesDB.create({
          id: 'test-dup-1',
          name: 'Duplicate Code User',
          passcode: 'member-code-1234',
        }),
      (err) => err.statusCode === 409
    );

    await assert.rejects(
      () => profilesDB.update(locked.id, { passcode: 'owner-secret-9999' }),
      (err) => err.statusCode === 409
    );

    // 3. Code-only authentication resolves the exact profile without knowing profile names
    const authOwner = authenticateByCode('owner-secret-9999');
    assert.equal(authOwner?.id, owner.id);
    assert.equal(authOwner?.role, 'owner');

    const authMember = authenticateByCode('member-code-1234');
    assert.equal(authMember?.id, member.id);
    assert.equal(authMember?.role, 'member');

    // 4. Invalid / empty / locked codes fail cleanly
    assert.equal(authenticateByCode('wrong-code-0000'), null);
    assert.equal(authenticateByCode(''), null);
    assert.equal(authenticateByCode(null), null);
  } finally {
    await profilesDB.delete(locked.id);
    await profilesDB.delete(member.id);
    // Keep last cleanup tolerant if test-owner-1 is the only profile in memory
    try {
      await profilesDB.delete(owner.id);
    } catch (_) {}
  }
});

test('requireAuth reconciles profile-bound JWTs, rejects legacy tokens, and requireOwner enforces RBAC', async () => {
  const owner = await profilesDB.create({
    id: 'test-rbac-owner',
    name: 'RBAC Owner',
    role: 'owner',
    passcode: 'rbac-owner-5678',
  });
  const member = await profilesDB.create({
    id: 'test-rbac-member',
    name: 'RBAC Member',
    role: 'member',
    passcode: 'rbac-member-5678',
  });
  const kids = await profilesDB.create({
    id: 'test-rbac-kids',
    name: 'RBAC Kids',
    role: 'member',
    is_kids: true,
    passcode: 'rbac-kids-5678',
  });

  try {
    // 1. Legacy token without profileId must be rejected (401)
    const legacyToken = jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '1h' });
    const legacyReq = { headers: { authorization: `Bearer ${legacyToken}` }, query: {} };
    const legacyRes = createMockRes();
    let nextCalled = false;
    requireAuth(legacyReq, legacyRes, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(legacyRes.statusCode, 401);

    // 2. Owner token passes requireAuth and requireOwner
    const ownerToken = generateToken(owner);
    const ownerReq = { headers: { authorization: `Bearer ${ownerToken}` }, query: {} };
    const ownerRes = createMockRes();
    let ownerPassed = false;
    requireAuth(ownerReq, ownerRes, () => {
      requireOwner(ownerReq, ownerRes, () => {
        ownerPassed = true;
      });
    });
    assert.equal(ownerPassed, true);
    assert.equal(ownerReq.user.profileId, owner.id);
    assert.equal(ownerReq.user.role, 'owner');

    // 3. Member token passes requireAuth, but is blocked (403) by requireOwner
    const memberToken = generateToken(member);
    const memberReq = { headers: { authorization: `Bearer ${memberToken}` }, query: {} };
    const memberRes = createMockRes();
    let memberReachedOwnerRoute = false;
    requireAuth(memberReq, memberRes, () => {
      requireOwner(memberReq, memberRes, () => {
        memberReachedOwnerRoute = true;
      });
    });
    assert.equal(memberReachedOwnerRoute, false);
    assert.equal(memberRes.statusCode, 403);

    // 4. Vault authorization strictly blocks member & kids EVEN WITH valid PRIVATE_PIN
    const memberVaultReq = {
      user: { profileId: member.id, role: 'member', is_kids: false, vault: true },
      headers: { 'x-vault-pin': config.privatePin },
      query: { pin: config.privatePin },
    };
    assert.equal(isVaultAuthorized(memberVaultReq), false);

    const kidsVaultReq = {
      user: { profileId: kids.id, role: 'owner', is_kids: true, vault: true },
      headers: { 'x-vault-pin': config.privatePin },
      query: { pin: config.privatePin },
    };
    assert.equal(isVaultAuthorized(kidsVaultReq), false);

    // Owner with valid PIN or vault JWT claim is authorized
    const ownerVaultReq = {
      user: { profileId: owner.id, role: 'owner', is_kids: false, vault: false },
      headers: { 'x-vault-pin': config.privatePin },
      query: {},
    };
    assert.equal(isVaultAuthorized(ownerVaultReq), true);
  } finally {
    await profilesDB.delete(kids.id);
    await profilesDB.delete(member.id);
    try {
      await profilesDB.delete(owner.id);
    } catch (_) {}
  }
});

test('createAuthRateLimiter blocks repeated failed attempts with 429 and resets on success', () => {
  const limiter = createAuthRateLimiter({ windowMs: 60_000, maxAttempts: 3 });

  const sendAttempt = (statusCode) => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.10' }, ip: '203.0.113.10' };
    const res = createMockRes();
    let passed = false;
    limiter(req, res, () => {
      passed = true;
      res.status(statusCode).json({ ok: statusCode === 200 });
    });
    return { passed, statusCode: res.statusCode, retryAfter: res.headers['retry-after'] };
  };

  assert.equal(sendAttempt(401).passed, true);
  assert.equal(sendAttempt(401).passed, true);
  assert.equal(sendAttempt(401).passed, true);

  // 4th attempt should be rate limited with 429 + Retry-After
  const blocked = sendAttempt(401);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.statusCode, 429);
  assert.ok(Number(blocked.retryAfter) >= 1);

  limiter.reset();
  assert.equal(sendAttempt(200).passed, true);
});

async function startAuthTestServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/profiles', profileRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('5-attempt lockout, 24h auto-fallback, WhatsApp reset ping, Owner reset & JWT revocation, and Owner-only change-code', async () => {
  await lockoutsDB.clearAll();
  await resetRequestsDB.clearAll();

  const owner = await profilesDB.create({
    id: 'test-flow-owner',
    name: 'Flow Owner',
    role: 'owner',
    passcode: 'flow-owner-9999',
  });
  const member = await profilesDB.create({
    id: 'test-flow-member',
    name: 'Alex',
    role: 'member',
    passcode: 'alex-code-1234',
  });

  const srv = await startAuthTestServer();
  const lockedIp = '198.51.100.42';
  const ownerIp = '198.51.100.99';

  const postJson = async (urlPath, body, { ip = lockedIp, token = null } = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      'x-forwarded-for': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(`${srv.baseUrl}${urlPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  const getJson = async (urlPath, { ip = lockedIp, token = null } = {}) => {
    const headers = {
      'x-forwarded-for': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(`${srv.baseUrl}${urlPath}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  try {
    // 1. Obtain valid Owner and Member tokens before lockout
    const ownerLogin = await postJson('/api/auth/login', { code: 'flow-owner-9999' }, { ip: ownerIp });
    assert.equal(ownerLogin.status, 200);
    let ownerToken = ownerLogin.data.token;

    const memberLogin = await postJson('/api/auth/login', { code: 'alex-code-1234' }, { ip: '198.51.100.77' });
    assert.equal(memberLogin.status, 200);
    const oldMemberToken = memberLogin.data.token;

    // 2. Non-owner MUST be blocked from /api/auth/change-code (closes 409 password-discovery oracle) and /reset-requests
    const memberChangeAttempt = await postJson(
      '/api/auth/change-code',
      { currentCode: 'alex-code-1234', newCode: 'flow-owner-9999' },
      { ip: '198.51.100.77', token: oldMemberToken }
    );
    assert.equal(memberChangeAttempt.status, 403);

    const memberInboxAttempt = await getJson('/api/profiles/reset-requests', {
      ip: '198.51.100.77',
      token: oldMemberToken,
    });
    assert.equal(memberInboxAttempt.status, 403);

    // 3. Owner wrong currentCode on /change-code returns 400 (not 401), and valid update returns refreshed token
    const ownerWrongCurrent = await postJson(
      '/api/auth/change-code',
      { currentCode: 'wrong-code', newCode: 'flow-owner-8888' },
      { ip: ownerIp, token: ownerToken }
    );
    assert.equal(ownerWrongCurrent.status, 400);

    const ownerChangeOk = await postJson(
      '/api/auth/change-code',
      { currentCode: 'flow-owner-9999', newCode: 'flow-owner-8888' },
      { ip: ownerIp, token: ownerToken }
    );
    assert.equal(ownerChangeOk.status, 200);
    assert.ok(ownerChangeOk.data.token);
    // Old owner token should now be rejected (passcode_version incremented), new token works
    const staleOwnerMe = await getJson('/api/auth/me', { ip: ownerIp, token: ownerToken });
    assert.equal(staleOwnerMe.status, 401);
    ownerToken = ownerChangeOk.data.token;
    const freshOwnerMe = await getJson('/api/auth/me', { ip: ownerIp, token: ownerToken });
    assert.equal(freshOwnerMe.status, 200);

    // 4. Requesting a reset BEFORE lockout must be rejected with 403
    const prematureReset = await postJson('/api/auth/request-reset', { profileName: 'Alex' }, { ip: lockedIp });
    assert.equal(prematureReset.status, 403);

    // 5. Four wrong attempts return 401 with decreasing attemptsRemaining
    for (let i = 1; i <= 4; i++) {
      const attempt = await postJson('/api/auth/login', { code: `wrong-code-${i}` }, { ip: lockedIp });
      assert.equal(attempt.status, 401);
      assert.equal(attempt.data.locked, false);
      assert.equal(attempt.data.failedAttempts, i);
      assert.equal(attempt.data.attemptsRemaining, 5 - i);
    }

    // 6. 5th wrong attempt triggers 423 Locked
    const fifth = await postJson('/api/auth/login', { code: 'wrong-code-5' }, { ip: lockedIp });
    assert.equal(fifth.status, 423);
    assert.equal(fifth.data.locked, true);
    assert.equal(fifth.data.attemptsRemaining, 0);

    // 7. Subsequent login even with VALID code is blocked (423) while locked
    const blockedValid = await postJson('/api/auth/login', { code: 'alex-code-1234' }, { ip: lockedIp });
    assert.equal(blockedValid.status, 423);
    assert.equal(blockedValid.data.locked, true);

    const statusCheck = await getJson('/api/auth/lockout-status', { ip: lockedIp });
    assert.equal(statusCheck.status, 200);
    assert.equal(statusCheck.data.locked, true);
    assert.equal(statusCheck.data.requestSent, false);

    // 8. 24-hour auto-fallback expiry check (simulated timestamp in future)
    const futureCheck = await lockoutsDB.getStatus(
      lockedIp,
      new Date(statusCheck.data.lockedAt).getTime() + LOCKOUT_DURATION_MS + 1000
    );
    assert.equal(futureCheck.locked, false);

    // Re-lock lockedIp for reset-request & Owner ping verification
    for (let i = 1; i <= 5; i++) {
      await lockoutsDB.recordFailure(lockedIp);
    }

    // 9. Locked-out user submits both a non-existent name and real name -> identical 201 shape (zero enumeration, no phone number)
    const ghostReq = await postJson('/api/auth/request-reset', { profileName: 'GhostUser' }, { ip: lockedIp });
    assert.equal(ghostReq.status, 201);
    assert.equal(ghostReq.data.success, true);
    assert.ok(ghostReq.data.whatsappUrl.startsWith('https://wa.me/?text='));

    const realReq = await postJson('/api/auth/request-reset', { profileName: 'alex' }, { ip: lockedIp });
    assert.equal(realReq.status, 201);
    assert.equal(realReq.data.success, true);
    assert.ok(realReq.data.whatsappUrl.startsWith('https://wa.me/?text='));
    assert.ok(realReq.data.whatsappMessage.includes('alex'));

    // 10. Owner checks in-app ping inbox and sees both pending requests (with silent match on Alex)
    const inbox = await getJson('/api/profiles/reset-requests', { ip: ownerIp, token: ownerToken });
    assert.equal(inbox.status, 200);
    assert.equal(inbox.data.pendingCount, 2);
    const ghostItem = inbox.data.requests.find((r) => r.requested_name === 'GhostUser');
    const alexItem = inbox.data.requests.find((r) => r.requested_name === 'alex');
    assert.ok(ghostItem);
    assert.equal(ghostItem.matched_profile_id, null);
    assert.ok(alexItem);
    assert.equal(alexItem.matched_profile_id, member.id);

    // 11. Dismissing GhostUser does NOT unlock lockedIp
    const dismissRes = await postJson(
      `/api/profiles/reset-requests/${ghostItem.id}/resolve`,
      { action: 'dismiss' },
      { ip: ownerIp, token: ownerToken }
    );
    assert.equal(dismissRes.status, 200);
    const stillLocked = await getJson('/api/auth/lockout-status', { ip: lockedIp });
    assert.equal(stillLocked.data.locked, true);

    // 12. Owner resets Alex's code (auto-generated) and unlocks lockedIp
    const resetRes = await postJson(
      `/api/profiles/reset-requests/${alexItem.id}/resolve`,
      { action: 'reset', profileId: member.id, generateCode: true },
      { ip: ownerIp, token: ownerToken }
    );
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.data.success, true);
    assert.ok(resetRes.data.newCode && resetRes.data.newCode.length >= 4);
    assert.ok(resetRes.data.shareWhatsappUrl.startsWith('https://wa.me/?text='));

    // Old Member JWT must now be revoked (401)
    const oldMemberMe = await getJson('/api/auth/me', { ip: '198.51.100.77', token: oldMemberToken });
    assert.equal(oldMemberMe.status, 401);

    // Locked IP is unlocked and can sign in with the new code immediately
    const unlockedStatus = await getJson('/api/auth/lockout-status', { ip: lockedIp });
    assert.equal(unlockedStatus.data.locked, false);

    const newCodeLogin = await postJson('/api/auth/login', { code: resetRes.data.newCode }, { ip: lockedIp });
    assert.equal(newCodeLogin.status, 200);
    assert.equal(newCodeLogin.data.profile.id, member.id);

    // Owner inbox is now empty
    const emptyInbox = await getJson('/api/profiles/reset-requests', { ip: ownerIp, token: ownerToken });
    assert.equal(emptyInbox.data.pendingCount, 0);
  } finally {
    await srv.close();
    await lockoutsDB.clearAll();
    await resetRequestsDB.clearAll();
    await profilesDB.delete(member.id);
    try {
      await profilesDB.delete(owner.id);
    } catch (_) {}
  }
});

test('renderResetRequestCard escapes XSS payloads and preselects matched profile', () => {
  const html = renderResetRequestCard(
    {
      id: 'rst_1',
      requested_name: '<img src=x onerror=alert(1)>',
      matched_profile_id: 'p2',
      matched_profile: { id: 'p2', name: 'Alex' },
      failed_attempts: 5,
      created_at: new Date().toISOString(),
    },
    [
      { id: 'default', name: 'Owner', role: 'owner' },
      { id: 'p2', name: 'Alex', role: 'member' },
    ]
  );

  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('value="p2" selected'));
  assert.ok(html.includes('Reset code &amp; unlock'));
  assert.ok(html.includes('Unlock only'));
  assert.ok(html.includes('Dismiss'));
});
