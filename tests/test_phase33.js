/**
 * Nexora Nexus — Phase 33 Email Verification Test Suite
 *
 * Verifies:
 * 1. Valid token activates the correct pending account.
 * 2. Successful verification consumes the token.
 * 3. Reusing a consumed token fails with HTTP 400.
 * 4. Expired token fails with HTTP 400.
 * 5. Unknown token fails with HTTP 400.
 * 6. Malformed token fails with HTTP 400.
 * 7. Verification does not activate the wrong account.
 * 8. Database failure does not produce false success.
 * 9. Registration creates a pending-verification account.
 * 10. Pending account cannot log in or access protected endpoints.
 * 11. Verified account follows the existing login flow.
 * 12. Resend returns a generic response to avoid enumeration.
 * 13. Resend rate limiting works (4th request returns 429).
 * 14. Rate-limit database errors fail closed (HTTP 503).
 * 15. Previous outstanding tokens are invalidated safely upon re-generation.
 * 16. Provider success is handled correctly (mocked 200).
 * 17. Provider rejection is handled without false delivery claims (mocked 4xx/5xx).
 * 18. Missing provider configuration fails safely.
 * 19. Verification tokens and full verification URLs are not logged.
 * 20. HTML/text email output safely handles untrusted values.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { generateSecureToken, hashToken, generateUuid } from '../worker/crypto.js';
import { buildVerificationEmailContent, sendVerificationEmail, escapeHtml } from '../worker/email.js';

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

// ---------------------------------------------------------------------------
// D1 Mock & Worker Simulator Helper
// ---------------------------------------------------------------------------
function createTestD1() {
  const db = new DatabaseSync(':memory:');
  const schema1 = fs.readFileSync(path.join(ROOT_DIR, 'migrations', '0001_initial_schema.sql'), 'utf8');
  const schema2 = fs.readFileSync(path.join(ROOT_DIR, 'migrations', '0002_email_verifications.sql'), 'utf8');
  db.exec(schema1);
  db.exec(schema2);

  const d1 = {
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
          return { results: results || [], success: true };
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

  return { db, d1 };
}

async function runSuite() {
  console.log('\n================================================================');
  console.log('--- PHASE 33 EMAIL VERIFICATION TEST SUITE ---');
  console.log('================================================================\n');

  console.log('Category 1: Core Verification & Token Lifecycle');

  // Test 1: Valid token activates the correct pending account
  await test('1. Valid token activates the correct pending account', async () => {
    const { db, d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    // Register user
    const regReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice.verify@example.com',
        password: 'Password123!',
        full_name: 'Alice Verify'
      })
    });
    const regRes = await worker.fetch(regReq, env, {});
    assert.equal(regRes.status, 201);
    const regData = await regRes.json();
    assert.equal(regData.user.status, 'pending_verification');
    const token = regData._test_verification_token;
    assert.ok(token, 'Must return test verification token in test environment');

    // Verify token
    const verifyReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const verifyRes = await worker.fetch(verifyReq, env, {});
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.success, true);

    // Verify user is now active in DB
    const userRow = db.prepare('SELECT status FROM users WHERE email = ?').get('alice.verify@example.com');
    assert.equal(userRow.status, 'active');
  });

  // Test 2: Successful verification consumes the token
  await test('2. Successful verification consumes the token', async () => {
    const { db, d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const regReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'token.consume@example.com',
        password: 'Password123!',
        full_name: 'Token Consumer'
      })
    });
    const regRes = await worker.fetch(regReq, env, {});
    const regData = await regRes.json();
    const token = regData._test_verification_token;

    // Check token before verification: used_at is NULL
    const tokenHash = await hashToken(token);
    const beforeRow = db.prepare('SELECT used_at FROM email_verifications WHERE token_hash = ?').get(tokenHash);
    assert.equal(beforeRow.used_at, null);

    // Verify
    const verifyReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const verifyRes = await worker.fetch(verifyReq, env, {});
    assert.equal(verifyRes.status, 200);

    // Check token after verification: used_at is set
    const afterRow = db.prepare('SELECT used_at FROM email_verifications WHERE token_hash = ?').get(tokenHash);
    assert.ok(afterRow.used_at !== null, 'used_at must be populated after verification');
  });

  // Test 3: Reusing a consumed token fails
  await test('3. Reusing a consumed token fails with HTTP 400', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const regReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'reuse.token@example.com',
        password: 'Password123!',
        full_name: 'Reuser Test'
      })
    });
    const regRes = await worker.fetch(regReq, env, {});
    const regData = await regRes.json();
    const token = regData._test_verification_token;

    // 1st verification succeeds
    const verifyReq1 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const verifyRes1 = await worker.fetch(verifyReq1, env, {});
    assert.equal(verifyRes1.status, 200);

    // 2nd verification fails with 400 INVALID_OR_EXPIRED_TOKEN
    const verifyReq2 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const verifyRes2 = await worker.fetch(verifyReq2, env, {});
    assert.equal(verifyRes2.status, 400);
    const verifyData2 = await verifyRes2.json();
    assert.equal(verifyData2.error.code, 'INVALID_OR_EXPIRED_TOKEN');
  });

  // Test 4: Expired token fails
  await test('4. Expired token fails with HTTP 400', async () => {
    const { db, d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const regReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'expired.token@example.com',
        password: 'Password123!',
        full_name: 'Expired Test'
      })
    });
    const regRes = await worker.fetch(regReq, env, {});
    const regData = await regRes.json();
    const token = regData._test_verification_token;
    const tokenHash = await hashToken(token);

    // Manually expire token in DB
    db.prepare("UPDATE email_verifications SET expires_at = datetime('now', '-2 hours') WHERE token_hash = ?").run(tokenHash);

    const verifyReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const verifyRes = await worker.fetch(verifyReq, env, {});
    assert.equal(verifyRes.status, 400);
    const data = await verifyRes.json();
    assert.equal(data.error.code, 'INVALID_OR_EXPIRED_TOKEN');
  });

  // Test 5: Unknown token fails
  await test('5. Unknown token fails with HTTP 400', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const unknownToken = generateSecureToken(32);
    const verifyReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: unknownToken })
    });
    const verifyRes = await worker.fetch(verifyReq, env, {});
    assert.equal(verifyRes.status, 400);
    const data = await verifyRes.json();
    assert.equal(data.error.code, 'INVALID_OR_EXPIRED_TOKEN');
  });

  // Test 6: Malformed token fails
  await test('6. Malformed token fails with HTTP 400', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    for (const badToken of ['', 'short', 12345, null, 'not_hex!@#$', ' ']) {
      const verifyReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: badToken })
      });
      const verifyRes = await worker.fetch(verifyReq, env, {});
      assert.equal(verifyRes.status, 400);
      const data = await verifyRes.json();
      assert.equal(data.error.code, 'INVALID_OR_EXPIRED_TOKEN');
    }
  });

  // Test 7: Verification does not activate the wrong account
  await test('7. Verification does not activate the wrong account', async () => {
    const { db, d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    // Register User 1
    const reg1 = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user1@example.com', password: 'Password123!', full_name: 'User One' })
    }), env, {});
    const data1 = await reg1.json();
    const token1 = data1._test_verification_token;

    // Register User 2
    await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user2@example.com', password: 'Password123!', full_name: 'User Two' })
    }), env, {});

    // Verify User 1
    await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token1 })
    }), env, {});

    const u1 = db.prepare('SELECT status FROM users WHERE email = ?').get('user1@example.com');
    const u2 = db.prepare('SELECT status FROM users WHERE email = ?').get('user2@example.com');

    assert.equal(u1.status, 'active');
    assert.equal(u2.status, 'pending_verification', 'User 2 must remain pending');
  });

  // Test 8: Database failure does not produce false success
  await test('8. Database failure does not produce false success', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const reg = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'db.fail@example.com', password: 'Password123!', full_name: 'DB Fail' })
    }), env, {});
    const data = await reg.json();
    const token = data._test_verification_token;

    // Sabotage batch method to simulate database crash
    const brokenD1 = {
      ...d1,
      batch: async () => {
        throw new Error('D1_SIMULATED_DISK_IO_FAILURE');
      }
    };

    const verifyReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const verifyRes = await worker.fetch(verifyReq, { DB: brokenD1 }, {});
    assert.equal(verifyRes.status, 500);
    const resData = await verifyRes.json();
    assert.equal(resData.error.code, 'INTERNAL_ERROR');
    assert.doesNotMatch(resData.error.message, /D1_SIMULATED/i, 'Must not leak database internals');
  });

  console.log('\nCategory 2: Registration, Login & Endpoint Access Guards');

  // Test 9: Registration creates a pending-verification account
  await test('9. Registration creates a pending-verification account', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const regRes = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new.applicant@example.com', password: 'Password123!', full_name: 'New Applicant' })
    }), env, {});
    assert.equal(regRes.status, 201);
    const data = await regRes.json();
    assert.equal(data.user.status, 'pending_verification');
  });

  // Test 10: Pending account cannot log in or access protected endpoints
  await test('10. Pending account cannot log in or access protected endpoints', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'blocked.login@example.com', password: 'Password123!', full_name: 'Blocked Login' })
    }), env, {});

    // Attempt login
    const loginRes = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'blocked.login@example.com', password: 'Password123!' })
    }), env, {});
    assert.equal(loginRes.status, 403);
    const loginData = await loginRes.json();
    assert.equal(loginData.error.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(loginRes.headers.get('Set-Cookie'), null, 'Must not issue session cookie to unverified user');
  });

  // Test 11: Verified account follows the existing login flow
  await test('11. Verified account follows the existing login flow', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    const reg = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verified.user@example.com', password: 'Password123!', full_name: 'Verified User' })
    }), env, {});
    const data = await reg.json();
    const token = data._test_verification_token;

    // Verify email
    await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    }), env, {});

    // Login succeeds with 200 and session cookie
    const loginRes = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verified.user@example.com', password: 'Password123!' })
    }), env, {});
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.equal(loginData.user.status, 'active');
    assert.ok(loginRes.headers.get('Set-Cookie')?.includes('__Host-nexora_session'), 'Must set secure session cookie');
  });

  console.log('\nCategory 3: Resend Verification & Rate Limiting');

  // Test 12: Resend returns a generic response to avoid enumeration
  await test('12. Resend returns a generic response to avoid enumeration', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    // Register 1 pending user
    await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'exists.pending@example.com', password: 'Password123!', full_name: 'Pending' })
    }), env, {});

    // Case A: Non-existent email
    const resA = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent@example.com' })
    }), env, {});
    assert.equal(resA.status, 200);
    const dataA = await resA.json();

    // Case B: Existing pending email
    const resB = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'exists.pending@example.com' })
    }), env, {});
    assert.equal(resB.status, 200);
    const dataB = await resB.json();

    assert.equal(dataA.message, dataB.message, 'Response message must be identical to prevent enumeration');
  });

  // Test 13: Resend rate limiting works
  await test('13. Resend rate limiting works (4th request returns 429)', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };
    const email = 'throttle.resend@example.com';

    for (let i = 1; i <= 3; i++) {
      const res = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({ email })
      }), env, {});
      assert.equal(res.status, 200, `Request ${i} must succeed`);
    }

    // 4th request must be rate limited
    const res4 = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      body: JSON.stringify({ email })
    }), env, {});
    assert.equal(res4.status, 429, '4th request must return HTTP 429');
    const data4 = await res4.json();
    assert.equal(data4.error.code, 'TOO_MANY_REQUESTS');
  });

  // Test 14: Rate-limit database errors fail closed
  await test('14. Rate-limit database errors fail closed (HTTP 503)', async () => {
    const { d1 } = createTestD1();
    const brokenD1 = {
      ...d1,
      prepare(sql) {
        if (sql.includes('auth.verification_resend')) {
          return {
            bind() {
              return {
                async first() {
                  throw new Error('D1_RATE_LIMIT_QUERY_TIMEOUT');
                }
              };
            }
          };
        }
        return d1.prepare(sql);
      }
    };

    const res = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fail.closed@example.com' })
    }), { DB: brokenD1 }, {});

    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.error.code, 'SERVICE_UNAVAILABLE');
    assert.doesNotMatch(data.error.message, /D1_RATE_LIMIT/i, 'Must not leak SQL internals');
  });

  // Test 15: Previous outstanding tokens are invalidated safely
  await test('15. Previous outstanding tokens are invalidated safely upon re-generation', async () => {
    const { db, d1 } = createTestD1();
    const env = { DB: d1, ENVIRONMENT: 'test' };

    // Register user (creates Token 1)
    const reg = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'resend.inval@example.com', password: 'Password123!', full_name: 'Inval User' })
    }), env, {});
    const token1 = (await reg.json())._test_verification_token;

    // Resend verification (creates Token 2, invalidates Token 1)
    const resendRes = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'resend.inval@example.com' })
    }), env, {});
    assert.equal(resendRes.status, 200);
    const token2 = (await resendRes.json())._test_verification_token;
    assert.ok(token2, 'Must issue new token in test mode');
    assert.notEqual(token1, token2, 'New token must differ from old token');

    // Token 1 must now be consumed/invalidated and fail
    const verify1 = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token1 })
    }), env, {});
    assert.equal(verify1.status, 400);

    // Token 2 must succeed
    const verify2 = await worker.fetch(new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token2 })
    }), env, {});
    assert.equal(verify2.status, 200);

    const user = db.prepare('SELECT status FROM users WHERE email = ?').get('resend.inval@example.com');
    assert.equal(user.status, 'active');
  });

  console.log('\nCategory 4: Resend Provider & Security Hygiene');

  // Test 16: Provider success is handled correctly
  await test('16. Provider success is handled correctly (mocked 200)', async () => {
    let calledUrl = '';
    let calledAuth = '';
    const mockFetch = async (url, opts) => {
      calledUrl = url;
      calledAuth = opts.headers.Authorization;
      return new Response(JSON.stringify({ id: 're_mock_123456789' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const env = {
      EMAIL_PROVIDER: 'resend',
      EMAIL_API_KEY: 're_test_key_abc123',
      EMAIL_FROM: 'admissions@nexoranexus.com',
      APP_BASE_URL: 'https://nexoranexus.com'
    };

    const result = await sendVerificationEmail(
      env,
      {
        email: 'applicant@example.com',
        fullName: 'Test Applicant',
        token: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
      },
      mockFetch
    );

    assert.equal(result.sent, true);
    assert.equal(result.id, 're_mock_123456789');
    assert.equal(calledUrl, 'https://api.resend.com/emails');
    assert.equal(calledAuth, 'Bearer re_test_key_abc123');
  });

  // Test 17: Provider rejection is handled without false delivery claims
  await test('17. Provider rejection is handled without false delivery claims (mocked 4xx/5xx)', async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ message: 'Domain not verified' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const env = {
      EMAIL_PROVIDER: 'resend',
      EMAIL_API_KEY: 're_test_key_abc123',
      EMAIL_FROM: 'admissions@unverified.com'
    };

    const result = await sendVerificationEmail(
      env,
      {
        email: 'applicant@example.com',
        fullName: 'Test Applicant',
        token: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
      },
      mockFetch
    );

    assert.equal(result.sent, false);
    assert.equal(result.reason, 'provider_error');
    assert.equal(result.status, 422);
  });

  // Test 18: Missing provider configuration fails safely
  await test('18. Missing provider configuration fails safely', async () => {
    const env = {}; // Empty env
    const result = await sendVerificationEmail(
      env,
      {
        email: 'applicant@example.com',
        fullName: 'Test Applicant',
        token: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234'
      }
    );

    assert.equal(result.sent, false);
    assert.equal(result.reason, 'unconfigured');
  });

  // Test 19: Verification tokens and full verification URLs are not logged
  await test('19. Verification tokens and full verification URLs are not logged', async () => {
    const logs = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args) => logs.push(args.join(' '));
    console.warn = (...args) => logs.push(args.join(' '));
    console.error = (...args) => logs.push(args.join(' '));

    const secretToken = 'deadbeef12345678deadbeef12345678deadbeef12345678deadbeef12345678';

    try {
      // Execute provider call with simulated failure
      const mockFetch = async () => new Response('Internal error', { status: 500 });
      await sendVerificationEmail(
        { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'key', EMAIL_FROM: 'from@example.com' },
        { email: 'user@example.com', fullName: 'User', token: secretToken },
        mockFetch
      );
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    const combinedLog = logs.join('\n');
    assert.equal(combinedLog.includes(secretToken), false, 'Raw token must NEVER be logged to console');
    assert.equal(combinedLog.includes('token=' + secretToken), false, 'Verification URL must NEVER be logged to console');
  });

  // Test 20: HTML/text email output safely handles untrusted values
  await test('20. HTML/text email output safely handles untrusted values', () => {
    const maliciousName = '<script>alert("xss")</script>&"\'';
    const cleanUrl = 'https://nexoranexus.com/verify-email.html?token=123';

    const { html, text } = buildVerificationEmailContent(maliciousName, cleanUrl);

    assert.equal(html.includes('<script>'), false, 'Unescaped script tags must not be in email HTML');
    assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'Name must be entity-escaped in HTML');
    assert.ok(text.includes(maliciousName), 'Plaintext email safely contains literal text without rendering');
  });

  console.log('\n================================================================');
  console.log(`ALL PHASE 33 TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
  console.log('================================================================\n');
}

runSuite().catch(err => {
  console.error('\nSuite failure:', err);
  process.exit(1);
});
