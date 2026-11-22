import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import EventEmitter from 'node:events';
import { config } from '../server/config/env.js';
import { profilesDB, sanitizeProfile } from '../server/db/database.js';
import {
  authenticateByCode,
  generateToken,
  requireAuth,
  requireOwner,
  isVaultAuthorized,
  createAuthRateLimiter,
} from '../server/services/auth.js';

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
    // 1. Passcode hashes must NEVER leak through sanitized responses
    assert.equal(owner.passcode_hash, undefined);
    assert.equal(owner.has_passcode, true);
    assert.equal(owner.role, 'owner');
    assert.equal(member.passcode_hash, undefined);
    assert.equal(member.has_passcode, true);
    assert.equal(member.role, 'member');
    assert.equal(locked.has_passcode, false);

    const publicList = profilesDB.getAll();
    assert.ok(publicList.every((p) => p.passcode_hash === undefined));
    assert.equal(sanitizeProfile(profilesDB.getRawById(owner.id)).passcode_hash, undefined);

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
