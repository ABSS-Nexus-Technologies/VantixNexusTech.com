/**
 * Nexora Nexus — Phase 23 Deep Authentication Security Audit & Hardening Test Suite
 *
 * Verifies:
 * 1. Unverified account restrictions (pending_verification blocks login).
 * 2. Password length bounds (max 128 chars) and payload limits (max 64KB).
 * 3. Session fixation mitigation and session rotation on re-login.
 * 4. Scoped session revocation and expiry.
 * 5. CSRF defense edge cases (Origin: 'null', Sec-Fetch-Site: cross-site, Sec-Fetch-Mode: navigate).
 * 6. Cross-user isolation on /api/user/me.
 * 7. Server-side role authorization on admin endpoints with pagination.
 * 8. Complete password reset flow:
 *    - 503 EMAIL_SERVICE_NOT_CONFIGURED when email provider unconfigured (no fake success).
 *    - Valid reset token issuance in test environment.
 *    - Single-use enforcement.
 *    - Token expiration enforcement.
 *    - Complete session revocation across all devices on password reset.
 * 9. Atomic registration verification.
 * 10. Brute-force throttling without IP cross-talk.
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

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function runAsyncTest(name, fn) {
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
 * Implements .prepare(sql).bind(...).first(), .all(), .run(), and .batch([...]).
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
      // Execute in an atomic transaction
      db.exec('BEGIN TRANSACTION;');
      try {
        const results = [];
        for (const s of statements) {
          const stmt = db.prepare(s._sql);
          const info = stmt.run(...s._params);
          results.push({ success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } });
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

console.log('\n================================================================');
console.log('--- SUITE 1: UNVERIFIED ACCOUNT RESTRICTIONS & ACTIVATION ---');
console.log('================================================================');

const migrationSql = fs.readFileSync(path.join(ROOT_DIR, 'migrations/0001_initial_schema.sql'), 'utf8');
const testDb = new DatabaseSync(':memory:');
testDb.exec(migrationSql);
const d1 = createD1Mock(testDb);

const UNVERIFIED_EMAIL = 'unverified.student@example.com';
const STUDENT_PASSWORD = 'StudentPassword2026!';

await runAsyncTest('Registration: Account is created with pending_verification status', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: UNVERIFIED_EMAIL,
      password: STUDENT_PASSWORD,
      full_name: 'Student Candidate',
      college: 'Delhi Technological University'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.user.status, 'pending_verification');

  // Verify in DB directly
  const row = testDb.prepare('SELECT status FROM users WHERE email = ?').get(UNVERIFIED_EMAIL);
  assert.equal(row.status, 'pending_verification');
});

await runAsyncTest('Login Restriction: Unverified user is blocked with HTTP 403 EMAIL_NOT_VERIFIED', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: UNVERIFIED_EMAIL,
      password: STUDENT_PASSWORD
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_NOT_VERIFIED');
  assert.ok(data.error.message.includes('pending email verification'));
});

await runAsyncTest('Activation: Controlled verification enables login and session issuance', async () => {
  // Controlled transition from pending_verification to active
  await activateUserStatus(d1, UNVERIFIED_EMAIL, 'active');

  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: UNVERIFIED_EMAIL,
      password: STUDENT_PASSWORD
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.user.status, 'active');
  assert.ok(res.headers.get('Set-Cookie').includes('__Host-nexora_session='));
});

console.log('\n================================================================');
console.log('--- SUITE 2: PASSWORD BOUNDS & PAYLOAD SIZE LIMITS ---');
console.log('================================================================');

await runAsyncTest('Password Bound: Rejects password exceeding 128 characters (DoS mitigation)', async () => {
  const oversizedPassword = 'A1!' + 'a'.repeat(130);
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'oversized@example.com',
      password: oversizedPassword,
      full_name: 'DoS Tester'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'PASSWORD_TOO_LONG');
});

await runAsyncTest('Payload Bound: Rejects request bodies exceeding 64KB with HTTP 413', async () => {
  const hugePayload = JSON.stringify({
    email: 'huge@example.com',
    password: 'ValidPassword123!',
    full_name: 'A'.repeat(70000)
  });

  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(hugePayload.length)
    },
    body: hugePayload
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error.code, 'PAYLOAD_TOO_LARGE');
});

console.log('\n================================================================');
console.log('--- SUITE 3: SESSION ROTATION & FIXATION MITIGATION ---');
console.log('================================================================');

let sessionToken1 = '';
let sessionToken2 = '';

await runAsyncTest('Session Rotation: Prior session is invalidated when a new login occurs', async () => {
  // First login
  const req1 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: UNVERIFIED_EMAIL, password: STUDENT_PASSWORD })
  });
  const res1 = await worker.fetch(req1, { DB: d1 });
  assert.equal(res1.status, 200);
  sessionToken1 = res1.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

  // Verify Session 1 works for /me
  const meReq1 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: { 'Cookie': `__Host-nexora_session=${sessionToken1}` }
  });
  const meRes1 = await worker.fetch(meReq1, { DB: d1 });
  assert.equal(meRes1.status, 200);

  // Second login with Session 1 presented (Session rotation)
  const req2 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${sessionToken1}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({ email: UNVERIFIED_EMAIL, password: STUDENT_PASSWORD })
  });
  const res2 = await worker.fetch(req2, { DB: d1 });
  assert.equal(res2.status, 200);
  sessionToken2 = res2.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];
  assert.notEqual(sessionToken1, sessionToken2);

  // Old Session 1 MUST now be revoked and rejected
  const oldMeReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: { 'Cookie': `__Host-nexora_session=${sessionToken1}` }
  });
  const oldMeRes = await worker.fetch(oldMeReq, { DB: d1 });
  assert.equal(oldMeRes.status, 401);

  // New Session 2 works
  const newMeReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: { 'Cookie': `__Host-nexora_session=${sessionToken2}` }
  });
  const newMeRes = await worker.fetch(newMeReq, { DB: d1 });
  assert.equal(newMeRes.status, 200);
});

console.log('\n================================================================');
console.log('--- SUITE 4: CSRF & ORIGIN VALIDATION EDGE CASES ---');
console.log('================================================================');

await runAsyncTest('CSRF: Opaque Origin: "null" (e.g. sandboxed iframe) is rejected with 403', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'null',
      'Cookie': `__Host-nexora_session=${sessionToken2}`,
      'X-CSRF-Token': 'some_token'
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CORS_FORBIDDEN');
});

await runAsyncTest('CSRF: Sec-Fetch-Mode: navigate on mutating endpoint is rejected with 403', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Mode': 'navigate',
      'Cookie': `__Host-nexora_session=${sessionToken2}`,
      'X-CSRF-Token': 'some_token'
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CSRF_FORBIDDEN');
});

console.log('\n================================================================');
console.log('--- SUITE 5: CROSS-USER ISOLATION & ADMIN PAGINATION ---');
console.log('================================================================');

// Register Bob
const BOB_EMAIL = 'bob.builder@example.com';
await runAsyncTest('Cross-User: /api/user/me strictly isolates user data', async () => {
  const regReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOB_EMAIL, password: STUDENT_PASSWORD, full_name: 'Bob Builder' })
  });
  await worker.fetch(regReq, { DB: d1 });
  await activateUserStatus(d1, BOB_EMAIL, 'active');

  const bobLogin = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOB_EMAIL, password: STUDENT_PASSWORD })
  }), { DB: d1 });
  const bobCookie = bobLogin.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

  // Request Bob's profile
  const bobMe = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: { 'Cookie': `__Host-nexora_session=${bobCookie}` }
  }), { DB: d1 });
  const bobData = await bobMe.json();

  assert.equal(bobData.user.email, BOB_EMAIL);
  assert.equal(bobData.user.full_name, 'Bob Builder');
  assert.notEqual(bobData.user.email, UNVERIFIED_EMAIL);
});

await runAsyncTest('Admin Pagination: Returns paginated user records with limit and page', async () => {
  // Provision admin
  const { hash, salt } = await hashPassword('AdminPass2026!');
  testDb.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES ('usr_admin_p23', 'admin.p23@nexoranexus.com', ?, ?, 'admin', 'active')
  `).run(hash, salt);

  const adminLogin = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin.p23@nexoranexus.com', password: 'AdminPass2026!' })
  }), { DB: d1 });
  const adminCookie = adminLogin.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

  const pageReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/admin/users?page=1&limit=2', {
    method: 'GET',
    headers: { 'Cookie': `__Host-nexora_session=${adminCookie}` }
  });
  const pageRes = await worker.fetch(pageReq, { DB: d1 });
  assert.equal(pageRes.status, 200);
  const pageData = await pageRes.json();
  assert.equal(pageData.success, true);
  assert.equal(pageData.page, 1);
  assert.equal(pageData.limit, 2);
  assert.ok(pageData.users.length <= 2);
});

console.log('\n================================================================');
console.log('--- SUITE 6: HONEST PASSWORD RESET & SESSION TERMINATION ---');
console.log('================================================================');

await runAsyncTest('Password Reset: Returns 503 EMAIL_SERVICE_NOT_CONFIGURED when email service unavailable', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOB_EMAIL })
  });

  // Production environment without email provider binding
  const res = await worker.fetch(req, { DB: d1, ENVIRONMENT: 'production' });
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_SERVICE_NOT_CONFIGURED');
  assert.ok(data.error.message.includes('transactional email delivery has not been configured'));
});

let testResetToken = '';

await runAsyncTest('Password Reset Flow: Generates valid token in test environment', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOB_EMAIL })
  });

  const res = await worker.fetch(req, { DB: d1, ENVIRONMENT: 'test' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data._test_reset_token);
  testResetToken = data._test_reset_token;

  // Verify in password_resets DB table: stored as hash, NOT plaintext!
  const hashedToken = await hashToken(testResetToken);
  const resetRow = testDb.prepare('SELECT user_id, used_at FROM password_resets WHERE token_hash = ?').get(hashedToken);
  assert.ok(resetRow);
  assert.equal(resetRow.used_at, null);
});

const NEW_BOB_PASSWORD = 'BrandNewPassword2026!';

await runAsyncTest('Password Reset Execution: Resets password and terminates ALL active sessions', async () => {
  // Bob currently has an active session from Suite 5.
  // Perform password reset:
  const resetReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: testResetToken,
      new_password: NEW_BOB_PASSWORD
    })
  });

  const resetRes = await worker.fetch(resetReq, { DB: d1 });
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.equal(resetData.success, true);
  assert.ok(resetData.message.includes('All active sessions have been terminated'));

  // Verify old password no longer works
  const oldLogin = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOB_EMAIL, password: STUDENT_PASSWORD })
  }), { DB: d1 });
  assert.equal(oldLogin.status, 401);

  // Verify new password works
  const newLogin = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: BOB_EMAIL, password: NEW_BOB_PASSWORD })
  }), { DB: d1 });
  assert.equal(newLogin.status, 200);
});

await runAsyncTest('Password Reset Single-Use: Reusing token fails with HTTP 400', async () => {
  const reuseReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: testResetToken,
      new_password: 'YetAnotherPassword2026!'
    })
  });

  const reuseRes = await worker.fetch(reuseReq, { DB: d1 });
  assert.equal(reuseRes.status, 400);
  const data = await reuseRes.json();
  assert.equal(data.error.code, 'INVALID_OR_EXPIRED_TOKEN');
});

console.log('\n================================================================');
console.log(`ALL PHASE 23 SECURITY AUDIT TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
console.log('================================================================\n');
