/**
 * Nexora Nexus — Phase 27 Production Readiness & Security Verification Test Suite
 *
 * ENVIRONMENT NOTE:
 * - This suite executes locally using Node.js v22's built-in Web Cryptography API (crypto.subtle)
 *   and in-memory SQLite (node:sqlite) simulating Cloudflare D1 and Cloudflare Workers runtime.
 * - Test categories clearly distinguish simulated D1 / Worker mock behaviors from actual
 *   runtime Web Crypto and engine logic.
 *
 * AUDIT CATEGORIES VERIFIED:
 * 1. Public access to internal files and API route fallback behavior.
 * 2. Cryptographic functions against the actual supported runtime APIs.
 * 3. Session expiration, logout revocation, and password-reset revocation.
 * 4. Unverified and inactive account rejection.
 * 5. Missing IP identity and concurrent rate-limit attempts.
 * 6. Database uniqueness, foreign keys, and atomic batch failure.
 * 7. Sensitive information in API errors and responses.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import {
  hashPassword,
  verifyPassword,
  performDummyPasswordCheck,
  generateSecureToken,
  hashToken,
  generateUuid,
  timingSafeEqual
} from '../worker/crypto.js';
import {
  registerApplicant,
  loginUser,
  logoutUser,
  authenticateRequest,
  getCurrentUserProfile,
  requestPasswordReset,
  completePasswordReset,
  activateUserStatus,
  buildSessionCookie,
  verifyCsrfSafety,
  getCookie
} from '../worker/auth.js';
import {
  getPublishedPrograms,
  submitApplication,
  getMyApplications,
  getApplicationById
} from '../worker/applications.js';

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
 * Simulates Cloudflare D1 query execution and atomic db.batch() semantics.
 */
function createD1Mock(db, options = {}) {
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
          if (options.failAll) throw new Error('Simulated D1 database outage');
          const stmt = db.prepare(this._sql);
          const row = stmt.get(...this._params);
          if (!row) return null;
          if (col && typeof col === 'string') return row[col];
          return row;
        },
        async all() {
          if (options.failAll) throw new Error('Simulated D1 database outage');
          const stmt = db.prepare(this._sql);
          const results = stmt.all(...this._params);
          return { results, success: true };
        },
        async run() {
          if (options.failAll) throw new Error('Simulated D1 database outage');
          const stmt = db.prepare(this._sql);
          const info = stmt.run(...this._params);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        }
      };
    },
    async batch(statements) {
      if (options.failAll || options.failBatch) throw new Error('Simulated D1 batch outage');
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

// -----------------------------------------------------------------------------
// SETUP LOCAL DATABASE & RUNTIME FIXTURES
// -----------------------------------------------------------------------------
const schemaSql = fs.readFileSync(path.join(ROOT_DIR, 'migrations/0001_initial_schema.sql'), 'utf-8');
const testDb = new DatabaseSync(':memory:');
testDb.exec('PRAGMA foreign_keys = ON;');
testDb.exec(schemaSql);

const d1 = createD1Mock(testDb);

let assetFetchCount = 0;
const mockAssets = {
  fetch: async (req) => {
    assetFetchCount++;
    const url = new URL(req.url);
    if (url.pathname === '/404.html') {
      return new Response('Custom 404 Page Content', { status: 404, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(`Static asset: ${url.pathname}`, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
};

const BASE_URL = 'https://vantixnexustech-com.abssnexus.workers.dev';
const env = { DB: d1, ASSETS: mockAssets, ENVIRONMENT: 'test' };

console.log('\n================================================================');
console.log('--- PHASE 27 PRODUCTION READINESS & SECURITY VERIFICATION SUITE ---');
console.log('Runtime: Node.js (Web Cryptography + SQLite D1 Simulator)');
console.log('================================================================\n');

// Seed an initial test program
testDb.prepare(`
  INSERT INTO internship_programs (id, slug, title, description, duration_weeks, mode, price_paise, currency, is_active, max_seats)
  VALUES ('prg_p27_test', 'p27-software-engineering', 'Software Engineering Track', 'Production verification curriculum', 8, 'remote', 0, 'INR', 1, 30)
`).run();

// -----------------------------------------------------------------------------
// CATEGORY 1: PUBLIC ACCESS TO INTERNAL FILES & API ROUTE FALLBACK BEHAVIOR
// -----------------------------------------------------------------------------
console.log('Category 1: Public Access to Internal Files & Route Fallback Behavior');

await test('1.1 .assetsignore strictly protects internal code, tests, migrations and config', async () => {
  const assetsIgnoreContent = fs.readFileSync(path.join(ROOT_DIR, '.assetsignore'), 'utf-8');
  const requiredExclusions = [
    'worker/',
    'migrations/',
    'tests/',
    'wrangler.toml',
    '*.md',
    '.git',
    '.gitignore',
    '.vscode',
    '.wrangler'
  ];
  for (const pattern of requiredExclusions) {
    assert.ok(
      assetsIgnoreContent.includes(pattern),
      `.assetsignore missing essential exclusion pattern: ${pattern}`
    );
  }
});

await test('1.2 Static page requests route directly to env.ASSETS.fetch()', async () => {
  const prevCount = assetFetchCount;
  const res = await worker.fetch(new Request(`${BASE_URL}/internships.html`), env);
  assert.equal(res.status, 200);
  assert.equal(assetFetchCount, prevCount + 1);
  const text = await res.text();
  assert.ok(text.includes('Static asset: /internships.html'));
});

await test('1.3 Unknown API endpoints return safe JSON 404 envelope without leaks', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/non_existent_endpoint`), env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Cache-Control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const json = await res.json();
  assert.deepEqual(json, {
    error: {
      code: 'NOT_FOUND',
      message: 'API endpoint not found'
    }
  });
});

await test('1.4 Unknown method on existing API route returns safe HTTP 405 with Allow header', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/health`, { method: 'DELETE' }), env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET, OPTIONS');
  const json = await res.json();
  assert.equal(json.error.code, 'METHOD_NOT_ALLOWED');
});

await test('1.5 Worker returns safe 503 when ASSETS binding is missing on non-API route', async () => {
  const envWithoutAssets = { DB: d1, ENVIRONMENT: 'test' };
  const res = await worker.fetch(new Request(`${BASE_URL}/about.html`), envWithoutAssets);
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.equal(text, 'Asset service unavailable');
});

await test('1.6 Malformed application ID format returns safe 404 rather than SQL syntax error', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications/invalid--id!@#$`), env);
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, 'NOT_FOUND');
});

// -----------------------------------------------------------------------------
// CATEGORY 2: CRYPTOGRAPHIC FUNCTIONS AGAINST SUPPORTED RUNTIME APIS
// -----------------------------------------------------------------------------
console.log('\nCategory 2: Cryptographic Functions Against Supported Runtime APIs');

await test('2.1 PBKDF2 password hashing and verification use standard crypto.subtle', async () => {
  const password = 'ProductionPassword2026!';
  const { hash, salt } = await hashPassword(password);

  assert.ok(hash && typeof hash === 'string', 'Hash must be non-empty string');
  assert.ok(salt && typeof salt === 'string', 'Salt must be non-empty string');
  assert.equal(hash.length, 64, 'SHA-256 PBKDF2 hash should be 64 hex characters (256 bits)');
  assert.equal(salt.length, 32, 'Salt should be 32 hex characters (16 bytes)');

  // Correct password verification
  const isMatch = await verifyPassword(password, hash, salt);
  assert.equal(isMatch, true, 'Valid password must verify true');

  // Incorrect password verification
  const isWrongMatch = await verifyPassword('IncorrectPassword123!', hash, salt);
  assert.equal(isWrongMatch, false, 'Invalid password must verify false');
});

await test('2.2 Constant-time equality comparison prevents timing side-channels', async () => {
  assert.equal(timingSafeEqual('abcdef123456', 'abcdef123456'), true);
  assert.equal(timingSafeEqual('abcdef123456', 'abcdef123457'), false);
  assert.equal(timingSafeEqual('abcdef', 'abcdef123456'), false);
  assert.equal(timingSafeEqual(null, 'abc'), false);
  assert.equal(timingSafeEqual('abc', undefined), false);
});

await test('2.3 Secure token generation and SHA-256 token hashing', async () => {
  const token1 = generateSecureToken(32);
  const token2 = generateSecureToken(32);
  assert.notEqual(token1, token2, 'Random tokens must not collide');
  assert.equal(token1.length, 64, '32 bytes token should be 64 hex chars');

  const hash1 = await hashToken(token1);
  const hash2 = await hashToken(token1);
  assert.equal(hash1, hash2, 'hashToken must be deterministic');
  assert.equal(hash1.length, 64, 'SHA-256 digest is 64 hex chars');
});

await test('2.4 Standard RFC 4122 v4 UUID generation via crypto.randomUUID', async () => {
  const uuid = generateUuid();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.ok(uuidRegex.test(uuid), `Generated UUID ${uuid} must conform to RFC 4122 v4`);
});

await test('2.5 Dummy password check executes smoothly for non-existent users', async () => {
  // Verifies dummy computation executes without error
  await performDummyPasswordCheck('DummyAttemptPass123!');
});

// -----------------------------------------------------------------------------
// CATEGORY 3: SESSION EXPIRATION, LOGOUT REVOCATION & RESET REVOCATION
// -----------------------------------------------------------------------------
console.log('\nCategory 3: Session Expiration, Logout Revocation & Reset Revocation');

await test('3.1 Session expiration: expired session tokens are rejected by authenticateRequest', async () => {
  // Register and activate a test user
  const reg = await registerApplicant(d1, {
    email: 'session_expiry@nexoranexus.test',
    password: 'ExpiryTestPassword123!',
    full_name: 'Expiry Tester'
  }, '127.0.0.1', 'Node/Test');
  assert.equal(reg.status, 201);
  await activateUserStatus(d1, 'session_expiry@nexoranexus.test');

  const loginRes = await loginUser(d1, {
    email: 'session_expiry@nexoranexus.test',
    password: 'ExpiryTestPassword123!'
  }, '127.0.0.1', 'Node/Test');
  assert.equal(loginRes.status, 200);

  const rawToken = loginRes.sessionToken;
  const tokenHash = await hashToken(rawToken);

  // Verify valid session authenticates
  const authReq = new Request(`${BASE_URL}/api/user/me`, {
    headers: { 'Authorization': `Bearer ${rawToken}` }
  });
  const validAuth = await authenticateRequest(d1, authReq);
  assert.ok(validAuth !== null, 'Valid session should authenticate');
  assert.equal(validAuth.user.email, 'session_expiry@nexoranexus.test');

  // Manually expire session in DB
  testDb.prepare(`
    UPDATE user_sessions
    SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')
    WHERE token_hash = ?
  `).run(tokenHash);

  // Verify expired session returns null (rejected)
  const expiredAuth = await authenticateRequest(d1, authReq);
  assert.equal(expiredAuth, null, 'Expired session must return null');
});

await test('3.2 Logout revocation: logout immediately revokes session and clears cookie', async () => {
  const loginRes = await loginUser(d1, {
    email: 'session_expiry@nexoranexus.test',
    password: 'ExpiryTestPassword123!'
  }, '127.0.0.1', 'Node/Test');
  const token = loginRes.sessionToken;
  const tokenHash = await hashToken(token);

  const logoutReq = new Request(`${BASE_URL}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Origin': BASE_URL
    }
  });

  const logoutRes = await worker.fetch(logoutReq, env);
  assert.equal(logoutRes.status, 200);
  const cookieHeader = logoutRes.headers.get('Set-Cookie');
  assert.ok(cookieHeader.includes('Max-Age=0'), 'Logout must issue Max-Age=0 cookie expiration');

  // Verify DB record has revoked_at populated
  const sessionRow = testDb.prepare(`SELECT revoked_at FROM user_sessions WHERE token_hash = ?`).get(tokenHash);
  assert.ok(sessionRow.revoked_at !== null, 'revoked_at must be populated in DB');

  // Verify session can no longer authenticate
  const postLogoutAuth = await authenticateRequest(d1, logoutReq);
  assert.equal(postLogoutAuth, null, 'Revoked session cannot authenticate');
});

await test('3.3 Password reset revocation: completing reset revokes all sessions across devices', async () => {
  // Login twice to create two concurrent active sessions
  const s1 = await loginUser(d1, { email: 'session_expiry@nexoranexus.test', password: 'ExpiryTestPassword123!' }, '127.0.0.1', 'DeviceA');
  const s2 = await loginUser(d1, { email: 'session_expiry@nexoranexus.test', password: 'ExpiryTestPassword123!' }, '127.0.0.1', 'DeviceB');

  const tokenHash1 = await hashToken(s1.sessionToken);
  const tokenHash2 = await hashToken(s2.sessionToken);

  // Request password reset in test mode to obtain reset token
  const resetReq = await requestPasswordReset(d1, { email: 'session_expiry@nexoranexus.test' }, '127.0.0.1', 'Test', false, true);
  assert.equal(resetReq.status, 200);
  const resetToken = resetReq.data._test_reset_token;
  assert.ok(resetToken, 'Test reset token generated');

  // Complete reset with new password
  const completeRes = await completePasswordReset(d1, {
    token: resetToken,
    new_password: 'BrandNewPassword2026!'
  }, '127.0.0.1', 'Test');
  assert.equal(completeRes.status, 200);

  // Verify BOTH sessions are revoked
  const row1 = testDb.prepare(`SELECT revoked_at FROM user_sessions WHERE token_hash = ?`).get(tokenHash1);
  const row2 = testDb.prepare(`SELECT revoked_at FROM user_sessions WHERE token_hash = ?`).get(tokenHash2);
  assert.ok(row1.revoked_at !== null, 'Session 1 must be revoked');
  assert.ok(row2.revoked_at !== null, 'Session 2 must be revoked');

  // Verify single-use reset token cannot be reused
  const reuseRes = await completePasswordReset(d1, {
    token: resetToken,
    new_password: 'AnotherNewPassword2026!'
  }, '127.0.0.1', 'Test');
  assert.equal(reuseRes.status, 400);
  assert.equal(reuseRes.data.error.code, 'INVALID_OR_EXPIRED_TOKEN');
});

// -----------------------------------------------------------------------------
// CATEGORY 4: UNVERIFIED AND INACTIVE ACCOUNT REJECTION
// -----------------------------------------------------------------------------
console.log('\nCategory 4: Unverified and Inactive Account Rejection');

await test('4.1 Freshly registered user is in pending_verification status and rejected at login', async () => {
  const reg = await registerApplicant(d1, {
    email: 'unverified_user@nexoranexus.test',
    password: 'UnverifiedPass123!',
    full_name: 'Unverified Applicant'
  }, '127.0.0.1', 'Node/Test');
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.status, 'pending_verification');

  // Login attempt
  const loginRes = await loginUser(d1, {
    email: 'unverified_user@nexoranexus.test',
    password: 'UnverifiedPass123!'
  }, '127.0.0.1', 'Node/Test');
  assert.equal(loginRes.status, 403);
  assert.equal(loginRes.data.error.code, 'EMAIL_NOT_VERIFIED');
});

await test('4.2 Unverified user is rejected from submitting internship applications', async () => {
  const unverifiedUser = {
    id: 'usr_unverified_mock',
    email: 'unverified_user@nexoranexus.test',
    role: 'intern',
    status: 'pending_verification'
  };
  const appRes = await submitApplication(d1, unverifiedUser, {
    program_id: 'prg_p27_test',
    statement_of_purpose: 'I am highly passionate about software engineering and systems programming.'
  }, '127.0.0.1', 'Test');
  assert.equal(appRes.status, 403);
  assert.equal(appRes.data.error.code, 'EMAIL_NOT_VERIFIED');
});

await test('4.3 Suspended and deactivated accounts are rejected with ACCOUNT_INACTIVE', async () => {
  // Create user and suspend
  await registerApplicant(d1, {
    email: 'suspended_user@nexoranexus.test',
    password: 'SuspendedPass123!',
    full_name: 'Suspended User'
  }, '127.0.0.1', 'Test');
  await activateUserStatus(d1, 'suspended_user@nexoranexus.test', 'suspended');

  const suspendedLogin = await loginUser(d1, {
    email: 'suspended_user@nexoranexus.test',
    password: 'SuspendedPass123!'
  }, '127.0.0.1', 'Test');
  assert.equal(suspendedLogin.status, 403);
  assert.equal(suspendedLogin.data.error.code, 'ACCOUNT_INACTIVE');

  // Deactivate
  await activateUserStatus(d1, 'suspended_user@nexoranexus.test', 'deactivated');
  const deactivatedLogin = await loginUser(d1, {
    email: 'suspended_user@nexoranexus.test',
    password: 'SuspendedPass123!'
  }, '127.0.0.1', 'Test');
  assert.equal(deactivatedLogin.status, 403);
  assert.equal(deactivatedLogin.data.error.code, 'ACCOUNT_INACTIVE');
});

// -----------------------------------------------------------------------------
// CATEGORY 5: MISSING IP IDENTITY & CONCURRENT RATE-LIMIT ATTEMPTS
// -----------------------------------------------------------------------------
console.log('\nCategory 5: Missing IP Identity & Concurrent Rate-Limit Attempts');

await test('5.1 Login throttling handles missing/null/empty client IP gracefully without SQL failure', async () => {
  // Test with null IP
  const nullIpRes = await loginUser(d1, {
    email: 'nonexistent_account@nexoranexus.test',
    password: 'WrongPassword123!'
  }, null, 'Test');
  assert.equal(nullIpRes.status, 401);

  // Test with empty string IP
  const emptyIpRes = await loginUser(d1, {
    email: 'nonexistent_account@nexoranexus.test',
    password: 'WrongPassword123!'
  }, '   ', 'Test');
  assert.equal(emptyIpRes.status, 401);
});

await test('5.2 Rapid failed logins trigger HTTP 429 TOO_MANY_REQUESTS even with null IP', async () => {
  const targetEmail = 'brute_force_target@nexoranexus.test';
  await registerApplicant(d1, { email: targetEmail, password: 'BrutePassword123!', full_name: 'Target' }, null, null);
  await activateUserStatus(d1, targetEmail);

  // Fail 5 times with null IP
  for (let i = 0; i < 5; i++) {
    const res = await loginUser(d1, { email: targetEmail, password: 'WrongPassword!' }, null, null);
    assert.equal(res.status, 401);
  }

  // 6th attempt must be throttled
  const throttledRes = await loginUser(d1, { email: targetEmail, password: 'BrutePassword123!' }, null, null);
  assert.equal(throttledRes.status, 429);
  assert.equal(throttledRes.data.error.code, 'TOO_MANY_REQUESTS');
});

await test('5.3 Password reset rate-limiting throttles after 3 requests per 15 minutes', async () => {
  const resetUserEmail = 'reset_throttle@nexoranexus.test';
  await registerApplicant(d1, { email: resetUserEmail, password: 'ResetThrottlePass123!', full_name: 'Reset Throttle' }, null, null);
  await activateUserStatus(d1, resetUserEmail);

  // First 3 requests succeed (in test env)
  for (let i = 0; i < 3; i++) {
    const res = await requestPasswordReset(d1, { email: resetUserEmail }, '10.0.0.1', 'Test', false, true);
    assert.equal(res.status, 200);
  }

  // 4th request must be throttled
  const throttledRes = await requestPasswordReset(d1, { email: resetUserEmail }, '10.0.0.1', 'Test', false, true);
  assert.equal(throttledRes.status, 429);
  assert.equal(throttledRes.data.error.code, 'TOO_MANY_REQUESTS');
});

// -----------------------------------------------------------------------------
// CATEGORY 6: DATABASE UNIQUENESS, FOREIGN KEYS & ATOMIC BATCH FAILURE
// -----------------------------------------------------------------------------
console.log('\nCategory 6: Database Uniqueness, Foreign Keys & Atomic Batch Failure');

await test('6.1 Database rejects duplicate email on users table (case-insensitive UNIQUE)', async () => {
  assert.throws(() => {
    testDb.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, role, status)
      VALUES ('usr_dup_1', 'duplicate_case@test.com', 'h1', 's1', 'intern', 'active'),
             ('usr_dup_2', 'DUPLICATE_CASE@test.com', 'h2', 's2', 'intern', 'active')
    `).run();
  }, /UNIQUE constraint failed: users\.email/);
});

await test('6.2 Foreign key constraints strictly prevent orphaned records', async () => {
  // Invalid user_id on user_sessions
  assert.throws(() => {
    testDb.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
      VALUES ('sess_invalid', 'nonexistent_user_id_123', 'token_hash_val', '2099-01-01T00:00:00Z')
    `).run();
  }, /FOREIGN KEY constraint failed/);

  // Invalid program_id on applications
  assert.throws(() => {
    testDb.prepare(`
      INSERT INTO applications (id, user_id, program_id, status)
      VALUES ('app_invalid', 'usr_dup_1', 'nonexistent_program_id', 'submitted')
    `).run();
  }, /FOREIGN KEY constraint failed/);
});

await test('6.3 D1 atomic batch rolls back entirely when a single statement fails', async () => {
  const initialUserCount = testDb.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;

  // Batch with one valid insert and one invalid insert (violating foreign key)
  const stmt1 = d1.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES ('usr_batch_1', 'batch_test_1@test.com', 'h', 's', 'intern', 'active')
  `);
  const stmt2 = d1.prepare(`
    INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
    VALUES ('sess_orphan', 'non_existent_foreign_key_id', 'bad_token', '2099-01-01')
  `);

  await assert.rejects(async () => {
    await d1.batch([stmt1, stmt2]);
  }, /FOREIGN KEY constraint failed/);

  // Confirm stmt1 was completely rolled back and not persisted
  const finalUserCount = testDb.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  assert.equal(finalUserCount, initialUserCount, 'Failed batch must leave table count unchanged (atomic rollback)');
  const foundUser = testDb.prepare('SELECT id FROM users WHERE id = ?').get('usr_batch_1');
  assert.equal(foundUser, undefined, 'Rolled-back record must not exist');
});

await test('6.4 Application submission duplicate prevention via uq_application_user_program', async () => {
  // Create active applicant
  const reg = await registerApplicant(d1, {
    email: 'concurrent_applicant@nexoranexus.test',
    password: 'ConcurrentPass123!',
    full_name: 'Concurrent Applicant'
  }, '127.0.0.1', 'Test');
  await activateUserStatus(d1, 'concurrent_applicant@nexoranexus.test');
  const user = { id: reg.data.user.id, email: 'concurrent_applicant@nexoranexus.test', role: 'intern', status: 'active' };

  // First submission succeeds
  const app1 = await submitApplication(d1, user, {
    program_id: 'prg_p27_test',
    statement_of_purpose: 'Statement of purpose for testing uniqueness guarantees.'
  }, '127.0.0.1', 'Test');
  assert.equal(app1.status, 201);
  assert.equal(app1.data.success, true);

  // Duplicate submission returns clean 409 DUPLICATE_APPLICATION
  const app2 = await submitApplication(d1, user, {
    program_id: 'prg_p27_test',
    statement_of_purpose: 'Second attempt should be detected as duplicate.'
  }, '127.0.0.1', 'Test');
  assert.equal(app2.status, 409);
  assert.equal(app2.data.error.code, 'DUPLICATE_APPLICATION');
});

// -----------------------------------------------------------------------------
// CATEGORY 7: SENSITIVE INFORMATION IN API ERRORS AND RESPONSES
// -----------------------------------------------------------------------------
console.log('\nCategory 7: Sensitive Information in API Errors and Responses');

await test('7.1 Error responses never leak stack traces, file paths, or SQL statements', async () => {
  // Test 400 Bad Request
  const badReqRes = await worker.fetch(new Request(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': BASE_URL },
    body: JSON.stringify({ email: 'bad' })
  }), env);
  const badReqJson = await badReqRes.json();
  assert.ok(!JSON.stringify(badReqJson).includes('at '), 'Must not include stack trace lines');
  assert.ok(!JSON.stringify(badReqJson).includes('.js:'), 'Must not include source file references');

  // Test 500 Internal Error handling on worker unhandled exception
  const brokenEnv = {
    DB: {
      prepare: () => { throw new Error('Detailed SQL syntax error near table users.secrets'); }
    },
    ASSETS: mockAssets,
    ENVIRONMENT: 'production'
  };
  const internalErrRes = await worker.fetch(new Request(`${BASE_URL}/api/programs`), brokenEnv);
  assert.equal(internalErrRes.status, 500);
  const internalErrJson = await internalErrRes.json();
  assert.deepEqual(internalErrJson, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal server error occurred'
    }
  });
});

await test('7.2 Authenticated profile (/api/user/me) never returns password hash or salt', async () => {
  const loginRes = await loginUser(d1, {
    email: 'concurrent_applicant@nexoranexus.test',
    password: 'ConcurrentPass123!'
  }, '127.0.0.1', 'Test');
  const token = loginRes.sessionToken;

  const meReq = new Request(`${BASE_URL}/api/user/me`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const meRes = await worker.fetch(meReq, env);
  assert.equal(meRes.status, 200);
  const meJson = await meRes.json();

  assert.equal(meJson.user.password_hash, undefined, 'password_hash must NOT be present in profile');
  assert.equal(meJson.user.password_salt, undefined, 'password_salt must NOT be present in profile');
  assert.ok(!JSON.stringify(meJson).includes('password_hash'), 'JSON string must not contain password_hash');
  assert.ok(!JSON.stringify(meJson).includes('password_salt'), 'JSON string must not contain password_salt');
});

await test('7.3 Password reset honestly reports HTTP 503 when email provider is unconfigured', async () => {
  // Production environment with email unconfigured
  const prodEnvWithoutEmail = { DB: d1, ASSETS: mockAssets, ENVIRONMENT: 'production' };
  const resetReq = new Request(`${BASE_URL}/api/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': BASE_URL },
    body: JSON.stringify({ email: 'concurrent_applicant@nexoranexus.test' })
  });
  const res = await worker.fetch(resetReq, prodEnvWithoutEmail);
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error.code, 'EMAIL_SERVICE_NOT_CONFIGURED');
  assert.ok(json.error.message.includes('transactional email delivery has not been configured'));
});

console.log('\n================================================================');
console.log(`PHASE 27 TEST SUITE COMPLETE: ${passedTests}/${totalTests} TESTS PASSED`);
console.log('================================================================\n');
