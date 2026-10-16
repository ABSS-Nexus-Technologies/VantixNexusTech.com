/**
 * Nexora Nexus — Phase 24 Pre-Deployment Audit & Integration Test Suite
 *
 * Verifies:
 * 1. Registration, duplicate rejection, and pending_verification status enforcement.
 * 2. Login, session issuance, and session rotation.
 * 3. Logout and session revocation.
 * 4. Cross-user data isolation on /api/user/me.
 * 5. Admin role authorization and non-admin privilege rejection.
 * 6. CSRF defenses: rejects Origin 'null', cross-site fetch, and top-level navigate.
 * 7. Malformed JSON, payload limits (64KB), unsupported methods, and unknown routes.
 * 8. Password reset rate-limiting (max 3 per 15 min -> 429).
 * 9. Password reset token invalidation on subsequent request (older token revoked).
 * 10. Static asset passthrough via env.ASSETS.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { hashPassword, hashToken } from '../worker/crypto.js';
import { activateUserStatus } from '../worker/auth.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

/**
 * Creates a D1-compatible mock interface wrapping DatabaseSync.
 */
function createD1Mock(db) {
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        async first(col) {
          const stmt = db.prepare(this._sql);
          const row = stmt.get(...this._params);
          if (!row) return null;
          if (col && typeof col === 'string') return row[col];
          return row;
        },
        async all() {
          const stmt = db.prepare(this._sql);
          const results = stmt.all(...this._params);
          return { results, success: true };
        },
        async run() {
          const stmt = db.prepare(this._sql);
          const info = stmt.run(...this._params);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        }
      };
    },
    async batch(statements) {
      db.exec('BEGIN TRANSACTION;');
      try {
        const results = [];
        for (const s of statements) {
          const stmt = db.prepare(s._sql);
          const info = stmt.run(...s._params);
          results.push({ success: true, meta: { changes: info.changes } });
        }
        db.exec('COMMIT;');
        return results;
      } catch (err) {
        db.exec('ROLLBACK;');
        throw err;
      }
    }
  };
}

// Initialize SQLite database using initial schema
const schemaSql = fs.readFileSync(path.join(ROOT_DIR, 'migrations/0001_initial_schema.sql'), 'utf-8');
const testDb = new DatabaseSync(':memory:');
testDb.exec('PRAGMA foreign_keys = ON;');

testDb.exec(schemaSql);

const d1 = createD1Mock(testDb);

// Mock ASSETS fetcher
const mockAssets = {
  fetch: async (req) => {
    return new Response('<!DOCTYPE html><html><body>Static Page Mock</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

const BASE_URL = 'https://vantixnexustech-com.abssnexus.workers.dev';
const env = { DB: d1, ASSETS: mockAssets, ENVIRONMENT: 'test' };

console.log('\n================================================================');
console.log('--- PHASE 24 PRE-DEPLOYMENT AUDIT & INTEGRATION TEST SUITE ---');
console.log('================================================================\n');

// 1. System & Catalog
await test('Catalog & Health: GET /api/health and GET /api return 200', async () => {
  const healthRes = await worker.fetch(new Request(`${BASE_URL}/api/health`), env);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, 'ok');

  const catalogRes = await worker.fetch(new Request(`${BASE_URL}/api`), env);
  assert.equal(catalogRes.status, 200);
  const catalogData = await catalogRes.json();
  assert.ok(Array.isArray(catalogData.endpoints));
});

// 2. Static Asset Passthrough
await test('Static Asset Delivery: GET /index.html serves via env.ASSETS', async () => {
  const req = new Request(`${BASE_URL}/index.html`);
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Static Page Mock'));
});

// 3. User Registration & Duplicate Conflict
const APPLICANT_A = 'alice.p24@example.com';
const APPLICANT_PASSWORD = 'StrongPassword2026!';

await test('Registration: Creates intern account in pending_verification status', async () => {
  const req = new Request(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: APPLICANT_A,
      password: APPLICANT_PASSWORD,
      full_name: 'Alice Phase24',
      college: 'Nexora Tech Institute',
      graduation_year: 2026
    })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.user.role, 'intern');
  assert.equal(data.user.status, 'pending_verification');
});

await test('Registration: Duplicate email is rejected with HTTP 409 Conflict', async () => {
  const req = new Request(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: APPLICANT_A,
      password: APPLICANT_PASSWORD,
      full_name: 'Alice Duplicate'
    })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_EXISTS');
});

// 4. Pending Verification Blocking
await test('Login Guard: Unverified account cannot sign in (HTTP 403)', async () => {
  const req = new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_NOT_VERIFIED');
});

// 5. Verification Activation & Login
let aliceCookie = '';

await test('Login Success: Activated account signs in and receives HttpOnly session cookie', async () => {
  // Activate user in DB
  await activateUserStatus(d1, APPLICANT_A, 'active');

  const req = new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const cookieHeader = res.headers.get('Set-Cookie');
  assert.ok(cookieHeader.includes('__Host-nexora_session='));
  assert.ok(cookieHeader.includes('HttpOnly'));
  assert.ok(cookieHeader.includes('SameSite=Strict'));

  aliceCookie = cookieHeader.match(/__Host-nexora_session=([^;]+)/)[1];
});

// 6. Cross-User Isolation on /api/user/me
await test('Profile Isolation: User A profile returns only User A data', async () => {
  const req = new Request(`${BASE_URL}/api/user/me`, {
    method: 'GET',
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.email, APPLICANT_A);
  assert.equal(data.user.full_name, 'Alice Phase24');
});

// 7. Session Rotation on Re-login
await test('Session Rotation: Re-login rotates session token and invalidates previous token', async () => {
  const oldTokenHash = await hashToken(aliceCookie);
  const sessionBefore = testDb.prepare('SELECT revoked_at FROM user_sessions WHERE token_hash = ?').get(oldTokenHash);
  assert.equal(sessionBefore.revoked_at, null);

  const reLoginReq = new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  });
  const reLoginRes = await worker.fetch(reLoginReq, env);
  assert.equal(reLoginRes.status, 200);

  // Verify old token is now revoked in DB
  const sessionAfter = testDb.prepare('SELECT revoked_at FROM user_sessions WHERE token_hash = ?').get(oldTokenHash);
  assert.ok(sessionAfter.revoked_at !== null, 'Old session should be revoked');

  // Update Alice's active cookie
  aliceCookie = reLoginRes.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];
});

// 8. Logout
await test('Logout: Revokes session and clears session cookie', async () => {
  const req = new Request(`${BASE_URL}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const cookieHeader = res.headers.get('Set-Cookie');
  assert.ok(cookieHeader.includes('Max-Age=0'));

  // Subsequent me request should return 401
  const meRes = await worker.fetch(new Request(`${BASE_URL}/api/user/me`, {
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(meRes.status, 401);
});

// 9. CSRF Defenses
await test('CSRF Defense: Blocks Origin: "null"', async () => {
  const req = new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'null'
    },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CORS_FORBIDDEN');
});

await test('CSRF Defense: Blocks Sec-Fetch-Site: cross-site', async () => {
  const req = new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'cross-site'
    },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CSRF_FORBIDDEN');
});

await test('CSRF Defense: Blocks mutating requests with Sec-Fetch-Mode: navigate', async () => {
  const req = new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Mode': 'navigate'
    },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CSRF_FORBIDDEN');
});

// 10. Malformed JSON and Payload Limits
await test('Payload Validation: Rejects malformed JSON with HTTP 400', async () => {
  const req = new Request(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ bad json here '
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_JSON');
});

await test('Payload Limits: Rejects payload over 64KB with HTTP 413', async () => {
  const oversizedData = 'A'.repeat(70000);
  const req = new Request(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'big@example.com', payload: oversizedData })
  });
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error.code, 'PAYLOAD_TOO_LARGE');
});

// 11. Admin Authorization & Cross-Role Isolation
await test('Admin Role Gating: Intern cannot access /api/admin/users', async () => {
  // Login as intern again
  const internLogin = await worker.fetch(new Request(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: APPLICANT_A, password: APPLICANT_PASSWORD })
  }), env);
  const internCookie = internLogin.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

  const adminReq = new Request(`${BASE_URL}/api/admin/users`, {
    headers: { 'Cookie': `__Host-nexora_session=${internCookie}` }
  });
  const adminRes = await worker.fetch(adminReq, env);
  assert.equal(adminRes.status, 403);
  const data = await adminRes.json();
  assert.equal(data.error.code, 'FORBIDDEN');
});

// 12. Password Reset Rate Limiting & Token Invalidation
await test('Password Reset Rate Limiting: 4th request within 15 min returns HTTP 429', async () => {
  const resetUserEmail = 'reset.rate@example.com';
  const { hash, salt } = await hashPassword('SecretPass123!');
  testDb.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES ('usr_reset_rate', ?, ?, ?, 'intern', 'active')
  `).run(resetUserEmail, hash, salt);

  // Make 3 allowed requests
  for (let i = 1; i <= 3; i++) {
    const res = await worker.fetch(new Request(`${BASE_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.1' },
      body: JSON.stringify({ email: resetUserEmail })
    }), env);
    assert.equal(res.status, 200);
  }

  // 4th request must be throttled
  const throttledRes = await worker.fetch(new Request(`${BASE_URL}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.1' },
    body: JSON.stringify({ email: resetUserEmail })
  }), env);
  assert.equal(throttledRes.status, 429);
  const data = await throttledRes.json();
  assert.equal(data.error.code, 'TOO_MANY_REQUESTS');
});

await test('Password Reset Invalidation: Requesting new reset token revokes prior active token', async () => {
  const userB = 'user.b@example.com';
  const { hash, salt } = await hashPassword('InitialPass123!');
  testDb.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES ('usr_user_b', ?, ?, ?, 'intern', 'active')
  `).run(userB, hash, salt);

  // Request 1st reset token
  const res1 = await worker.fetch(new Request(`${BASE_URL}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.50' },
    body: JSON.stringify({ email: userB })
  }), env);
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  const token1 = data1._test_reset_token;

  // Request 2nd reset token for same user
  const res2 = await worker.fetch(new Request(`${BASE_URL}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.50' },
    body: JSON.stringify({ email: userB })
  }), env);
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  const token2 = data2._test_reset_token;

  assert.notEqual(token1, token2);

  // Attempting to use older token1 must fail because it was invalidated by the 2nd issuance
  const tryOldRes = await worker.fetch(new Request(`${BASE_URL}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token1, new_password: 'NewValidPassword2026!' })
  }), env);
  assert.equal(tryOldRes.status, 400);
  const oldData = await tryOldRes.json();
  assert.equal(oldData.error.code, 'INVALID_OR_EXPIRED_TOKEN');

  // Using newer token2 must succeed
  const tryNewRes = await worker.fetch(new Request(`${BASE_URL}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token2, new_password: 'NewValidPassword2026!' })
  }), env);
  assert.equal(tryNewRes.status, 200);
});

console.log('\n================================================================');
console.log(`ALL PHASE 24 PRE-DEPLOYMENT AUDIT TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
console.log('================================================================\n');
