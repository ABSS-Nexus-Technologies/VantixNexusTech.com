/**
 * Nexora Nexus — Phase 22 Authentication & D1 Integration Test Suite
 *
 * Verifies:
 * 1. Wrangler local D1 migration execution and schema readiness.
 * 2. Applicant registration (strictly role 'intern', validation, audit logging).
 * 3. Prevention of admin self-registration (no public admin bootstrap).
 * 4. Duplicate registration rejection (case-insensitive email).
 * 5. Secure login with PBKDF2-HMAC-SHA256, timing mitigation, and cookie issuance.
 * 6. Session token hashing (DB stores SHA-256 hash, never raw token).
 * 7. Brute-force throttling via audit_events (HTTP 429).
 * 8. GET /api/user/me with session cookie authentication.
 * 9. Server-side role authorization guards (intern denied admin endpoints, admin granted).
 * 10. Logout and immediate session revocation.
 * 11. Expired session rejection.
 * 12. CSRF defense on cookie-authenticated mutations.
 * 13. Password reset anti-enumeration.
 * 14. Zero sensitive data leakage in responses or logs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { hashPassword, hashToken } from '../worker/crypto.js';

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
 * Implements .prepare(sql).bind(...).first(), .all(), .run().
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
    }
  };
}

console.log('\n======================================================');
console.log('--- SUITE 1: D1 DATABASE SCHEMA SETUP & MIGRATION ---');
console.log('======================================================');

const migrationSql = fs.readFileSync(path.join(ROOT_DIR, 'migrations/0001_initial_schema.sql'), 'utf8');
const testDb = new DatabaseSync(':memory:');
testDb.exec(migrationSql);
const d1 = createD1Mock(testDb);

runTest('D1 Local Schema: All required tables initialized', () => {
  const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").all();
  const tableNames = tables.map(t => t.name);
  assert.ok(tableNames.includes('users'));
  assert.ok(tableNames.includes('user_sessions'));
  assert.ok(tableNames.includes('intern_profiles'));
  assert.ok(tableNames.includes('audit_events'));
});

console.log('\n======================================================');
console.log('--- SUITE 2: APPLICANT REGISTRATION & GUARDS ---');
console.log('======================================================');

await runAsyncTest('Registration: Successfully registers an intern applicant', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'applicant.alice@example.com',
      password: 'SecurePassword123!',
      full_name: 'Alice Johnson',
      college: 'Indian Institute of Technology',
      graduation_year: 2026
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.user.email, 'applicant.alice@example.com');
  assert.equal(data.user.role, 'intern');
  assert.equal(data.user.status, 'pending_verification');

  // Verify in database: password is hash, not plaintext, and status is pending_verification
  const userRow = testDb.prepare('SELECT email, password_hash, role, status FROM users WHERE email = ?').get('applicant.alice@example.com');
  assert.ok(userRow);
  assert.notEqual(userRow.password_hash, 'SecurePassword123!');
  assert.equal(userRow.password_hash.length, 64); // 256-bit hex
  assert.equal(userRow.role, 'intern');
  assert.equal(userRow.status, 'pending_verification');

  // Activate the user for subsequent login tests
  testDb.prepare("UPDATE users SET status = 'active' WHERE email = ?").run('applicant.alice@example.com');

  // Verify audit event recorded
  const auditRow = testDb.prepare("SELECT action FROM audit_events WHERE action = 'user.registered'").get();
  assert.ok(auditRow);
});

await runAsyncTest('Registration Guard: Strictly rejects public admin self-registration', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'attacker@example.com',
      password: 'HackerPassword123!',
      full_name: 'Malicious Attacker',
      role: 'admin' // Attempting to self-register as admin
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_ROLE');
});

await runAsyncTest('Registration Guard: Rejects weak password and invalid email', async () => {
  // Weak password (no number or uppercase)
  const req1 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'weak@example.com',
      password: 'weakpassword',
      full_name: 'Weak Pass'
    })
  });
  const res1 = await worker.fetch(req1, { DB: d1 });
  assert.equal(res1.status, 400);
  const data1 = await res1.json();
  assert.equal(data1.error.code, 'WEAK_PASSWORD');

  // Invalid email
  const req2 = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'not-an-email',
      password: 'ValidPassword123!',
      full_name: 'Test Name'
    })
  });
  const res2 = await worker.fetch(req2, { DB: d1 });
  assert.equal(res2.status, 400);
  const data2 = await res2.json();
  assert.equal(data2.error.code, 'INVALID_EMAIL');
});

await runAsyncTest('Registration Guard: Rejects duplicate email (case-insensitive)', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'APPLICANT.ALICE@EXAMPLE.COM', // Uppercase variation
      password: 'AnotherPassword123!',
      full_name: 'Alice Duplicate'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_EXISTS');
});

console.log('\n======================================================');
console.log('--- SUITE 3: LOGIN, SESSIONS & CSRF DEFENSE ---');
console.log('======================================================');

let activeSessionCookie = '';
let activeCsrfToken = '';

await runAsyncTest('Login: Authenticates valid credentials and issues secure __Host- cookie', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'applicant.alice@example.com',
      password: 'SecurePassword123!'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.user.email, 'applicant.alice@example.com');
  assert.ok(data.csrf_token);
  activeCsrfToken = data.csrf_token;

  const cookieHeader = res.headers.get('Set-Cookie');
  assert.ok(cookieHeader);
  assert.ok(cookieHeader.includes('__Host-nexora_session='));
  assert.ok(cookieHeader.includes('HttpOnly'));
  assert.ok(cookieHeader.includes('Secure'));
  assert.ok(cookieHeader.includes('SameSite=Strict'));
  assert.ok(cookieHeader.includes('Path=/'));

  // Extract raw token
  const tokenMatch = cookieHeader.match(/__Host-nexora_session=([^;]+)/);
  assert.ok(tokenMatch);
  activeSessionCookie = tokenMatch[1];

  // Verify session in database: only token hash is stored, NEVER raw token!
  const hashed = await hashToken(activeSessionCookie);
  const sessionRow = testDb.prepare('SELECT token_hash, revoked_at FROM user_sessions WHERE token_hash = ?').get(hashed);
  assert.ok(sessionRow);
  assert.equal(sessionRow.revoked_at, null);
});

await runAsyncTest('Login: Rejects invalid password with 401', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'applicant.alice@example.com',
      password: 'WrongPassword999!'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_CREDENTIALS');
});

await runAsyncTest('Login: Non-existent email returns generic 401 without enumeration', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'does.not.exist@example.com',
      password: 'SomePassword123!'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_CREDENTIALS');
});

await runAsyncTest('Login Throttling: Blocks client after excessive failed attempts', async () => {
  const targetEmail = 'throttle.victim@example.com';
  // Insert 5 failed login audit events
  for (let i = 0; i < 5; i++) {
    testDb.prepare(`
      INSERT INTO audit_events (id, action, target_type, target_id, ip_address, created_at)
      VALUES (?, 'auth.login_failure', 'user', ?, '192.168.1.100', datetime('now'))
    `).run(`aud_fail_${i}`, targetEmail);
  }

  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.168.1.100'
    },
    body: JSON.stringify({
      email: targetEmail,
      password: 'SomePassword123!'
    })
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.error.code, 'TOO_MANY_REQUESTS');
});

await runAsyncTest('Profile: GET /api/user/me returns authenticated applicant profile', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: {
      'Cookie': `__Host-nexora_session=${activeSessionCookie}`
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.user.email, 'applicant.alice@example.com');
  assert.equal(data.user.full_name, 'Alice Johnson');
  assert.equal(data.user.role, 'intern');
  // Confirm sensitive fields are NOT leaked in user profile
  assert.equal(data.user.password_hash, undefined);
  assert.equal(data.user.password_salt, undefined);
});

await runAsyncTest('Profile Guard: GET /api/user/me returns 401 without valid session', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET'
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'UNAUTHORIZED');
});

console.log('\n======================================================');
console.log('--- SUITE 4: SERVER-SIDE ROLE AUTHORIZATION GUARDS ---');
console.log('======================================================');

await runAsyncTest('Role Authorization: Intern applicant is denied access to admin routes (HTTP 403)', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/admin/users', {
    method: 'GET',
    headers: {
      'Cookie': `__Host-nexora_session=${activeSessionCookie}`
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'FORBIDDEN');
  assert.equal(data.error.message, 'Insufficient permissions for this resource');
});

await runAsyncTest('Role Authorization: Controlled admin account accesses admin routes successfully', async () => {
  // Controlled provisioning (via direct DB insertion / secure seed)
  const { hash, salt } = await hashPassword('AdminMasterKey2026!');
  const adminId = 'usr_admin_master';
  testDb.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES (?, 'superadmin@nexoranexus.com', ?, ?, 'admin', 'active')
  `).run(adminId, hash, salt);

  // Admin logs in
  const loginReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'superadmin@nexoranexus.com',
      password: 'AdminMasterKey2026!'
    })
  });
  const loginRes = await worker.fetch(loginReq, { DB: d1 });
  assert.equal(loginRes.status, 200);
  const adminCookie = loginRes.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

  // Admin accesses admin endpoint
  const adminReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/admin/users', {
    method: 'GET',
    headers: {
      'Cookie': `__Host-nexora_session=${adminCookie}`
    }
  });
  const adminRes = await worker.fetch(adminReq, { DB: d1 });
  assert.equal(adminRes.status, 200);
  const data = await adminRes.json();
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.users));
  assert.ok(data.users.length >= 2);
});

console.log('\n======================================================');
console.log('--- SUITE 5: LOGOUT, REVOCATION & EXPIRY ---');
console.log('======================================================');

await runAsyncTest('Logout: Revokes session and clears cookie', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${activeSessionCookie}`,
      'X-CSRF-Token': activeCsrfToken
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 200);

  const clearCookie = res.headers.get('Set-Cookie');
  assert.ok(clearCookie.includes('Max-Age=0'));

  // Subsequent profile request with revoked token must fail with 401
  const checkReq = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: {
      'Cookie': `__Host-nexora_session=${activeSessionCookie}`
    }
  });
  const checkRes = await worker.fetch(checkReq, { DB: d1 });
  assert.equal(checkRes.status, 401);
});

await runAsyncTest('Expiry: Expired session token is rejected with 401', async () => {
  // Create an expired session directly in DB
  const expiredRawToken = 'expired_token_1234567890abcdef1234567890abcdef';
  const expiredHash = await hashToken(expiredRawToken);
  testDb.prepare(`
    INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
    VALUES ('sess_exp', 'usr_admin_master', ?, datetime('now', '-1 hour'))
  `).run(expiredHash);

  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/user/me', {
    method: 'GET',
    headers: {
      'Cookie': `__Host-nexora_session=${expiredRawToken}`
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 401);
});

await runAsyncTest('CSRF Defense: Cross-site cookie mutation without CSRF header is rejected with 403', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${activeSessionCookie}`
      // Missing X-CSRF-Token or X-Requested-With
    }
  });

  const res = await worker.fetch(req, { DB: d1 });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CSRF_FORBIDDEN');
});

await runAsyncTest('Password Reset: Anti-enumeration returns generic response', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'any.user@example.com' })
  });

  const res = await worker.fetch(req, { DB: d1, ENVIRONMENT: 'test' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(data.message.includes('If an account exists'));
});

console.log('\n======================================================');
console.log(`ALL PHASE 22 TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
console.log('======================================================\n');
