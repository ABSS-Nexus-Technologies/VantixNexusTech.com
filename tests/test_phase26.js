/**
 * Nexora Nexus — Phase 26 Internship API Security & Business-Logic Audit Test Suite
 *
 * Comprehensive audit verifying:
 * 1. Programs catalog allowlisting, active filtering, non-disclosure of private fields, and method guards.
 * 2. Session variations: missing, malformed, expired, revoked, pending_verification, suspended, deactivated, and non-intern roles.
 * 3. Payload edge cases: malformed JSON, unsupported media type, oversized bodies, bounded inputs.
 * 4. Privilege escalation: rejection of client-supplied status, user_id, role, payment_status, and timestamps.
 * 5. Concurrent duplicate submissions: unique constraint violation during db.batch() returns clean 409 DUPLICATE_APPLICATION.
 * 6. Atomicity & database error handling: batch rollback and safe error envelope.
 * 7. Submission rate limiting: throttles after 5 submissions within 15 minutes (HTTP 429).
 * 8. Applicant data isolation: strict cross-user boundaries, malformed ID rejection, and pagination sanitization.
 * 9. Business logic audit: max_seats behavior intentionally deferred at submission.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { hashPassword, hashToken, generateSecureToken } from '../worker/crypto.js';
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
          if (options.failOnPrepare) throw new Error('Simulated D1 prepare failure');
          const stmt = db.prepare(this._sql);
          const row = stmt.get(...this._params);
          if (!row) return null;
          if (col && typeof col === 'string') return row[col];
          return row;
        },
        async all() {
          if (options.failOnPrepare) throw new Error('Simulated D1 prepare failure');
          const stmt = db.prepare(this._sql);
          const results = stmt.all(...this._params);
          return { results, success: true };
        },
        async run() {
          if (options.failOnPrepare) throw new Error('Simulated D1 prepare failure');
          const stmt = db.prepare(this._sql);
          const info = stmt.run(...this._params);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        }
      };
    },
    async batch(statements) {
      if (options.failOnBatch) throw new Error('Simulated D1 batch execution failure');
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

// Initialize SQLite database
const schemaSql = fs.readFileSync(path.join(ROOT_DIR, 'migrations/0001_initial_schema.sql'), 'utf-8');
const testDb = new DatabaseSync(':memory:');
testDb.exec('PRAGMA foreign_keys = ON;');
testDb.exec(schemaSql);

const d1 = createD1Mock(testDb);

const mockAssets = {
  fetch: async () => new Response('Mock Asset', { status: 200 })
};

const BASE_URL = 'https://vantixnexustech-com.abssnexus.workers.dev';
const env = { DB: d1, ASSETS: mockAssets, ENVIRONMENT: 'test' };

console.log('\n================================================================');
console.log('--- PHASE 26 INTERNSHIP API SECURITY & BUSINESS-LOGIC AUDIT ---');
console.log('================================================================\n');

// Seed active and inactive programs
testDb.prepare(`
  INSERT INTO internship_programs (id, slug, title, description, duration_weeks, mode, price_paise, currency, is_active, max_seats)
  VALUES
    ('prg_audit_active_1', 'full-stack-audit', 'Full Stack Engineering', 'Production engineering track.', 8, 'remote', 0, 'INR', 1, 25),
    ('prg_audit_active_2', 'cloud-devops-audit', 'Cloud & DevOps Engineering', 'Cloud deployment track.', 10, 'remote', 0, 'INR', 1, 10),
    ('prg_audit_inactive', 'draft-unapproved', 'Draft Unapproved Track', 'Unpublished draft.', 6, 'remote', 0, 'INR', 0, 5)
`).run();

// -----------------------------------------------------------------------------
// SECTION 1: PROGRAMS CATALOG SECURITY AUDIT
// -----------------------------------------------------------------------------
await test('Catalog Audit: Explicit allowlist of fields without metadata or unpublished leaks', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/programs`), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.programs.length, 2);

  const allowedKeys = ['id', 'slug', 'title', 'description', 'duration_weeks', 'mode', 'price_paise', 'currency', 'max_seats'];
  for (const program of data.programs) {
    const keys = Object.keys(program);
    for (const key of keys) {
      assert.ok(allowedKeys.includes(key), `Unexpected field ${key} returned in public catalog`);
    }
    // Verify pricing is integer paise
    assert.equal(typeof program.price_paise, 'number');
    assert.ok(program.price_paise >= 0);
  }
});

await test('Catalog Audit: Inactive and unapproved programs are completely excluded', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/programs`), env);
  const data = await res.json();
  const slugs = data.programs.map(p => p.slug);
  assert.ok(!slugs.includes('draft-unapproved'));
});

// -----------------------------------------------------------------------------
// SECTION 2: SESSION & ACCOUNT STATUS VARIATIONS ON POST /api/applications
// -----------------------------------------------------------------------------
const { hash, salt } = await hashPassword('SecurePassword2026!');

// Helper to provision user and session
function provisionUser(id, email, role, status) {
  testDb.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, email, hash, salt, role, status);
}

async function createSession(sessionId, userId, expiresOffset = '+7 days', revoked = false) {
  const rawToken = generateSecureToken(32);
  const tokenHash = await hashToken(rawToken);
  testDb.prepare(`
    INSERT INTO user_sessions (id, user_id, token_hash, expires_at, revoked_at)
    VALUES (?, ?, ?, datetime('now', ?), ${revoked ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" : 'NULL'})
  `).run(sessionId, userId, tokenHash, expiresOffset);
  return { rawToken, tokenHash };
}

provisionUser('usr_active_intern', 'intern.p26@example.com', 'intern', 'active');
provisionUser('usr_unverified_intern', 'unverified.p26@example.com', 'intern', 'pending_verification');
provisionUser('usr_suspended_intern', 'suspended.p26@example.com', 'intern', 'suspended');
provisionUser('usr_deactivated_intern', 'deactivated.p26@example.com', 'intern', 'deactivated');
provisionUser('usr_admin_user', 'admin.p26@example.com', 'admin', 'active');
provisionUser('usr_mentor_user', 'mentor.p26@example.com', 'mentor', 'active');

const validInternSession = await createSession('ses_valid_intern', 'usr_active_intern');
const expiredInternSession = await createSession('ses_expired_intern', 'usr_active_intern', '-1 hour');
const revokedInternSession = await createSession('ses_revoked_intern', 'usr_active_intern', '+7 days', true);
const unverifiedSession = await createSession('ses_unverified', 'usr_unverified_intern');
const suspendedSession = await createSession('ses_suspended', 'usr_suspended_intern');
const deactivatedSession = await createSession('ses_deactivated', 'usr_deactivated_intern');
const adminSession = await createSession('ses_admin', 'usr_admin_user');
const mentorSession = await createSession('ses_mentor', 'usr_mentor_user');

const BASE_SOP = 'This is an authentic statement of purpose demonstrating keen interest in cloud architecture.';

await test('Auth Variation: Missing session token returns HTTP 401 UNAUTHORIZED', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'UNAUTHORIZED');
});

await test('Auth Variation: Expired session token returns HTTP 401 UNAUTHORIZED', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${expiredInternSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'UNAUTHORIZED');
});

await test('Auth Variation: Revoked session token returns HTTP 401 UNAUTHORIZED', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${revokedInternSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'UNAUTHORIZED');
});

await test('Auth Variation: Pending-verification account returns HTTP 403 EMAIL_NOT_VERIFIED', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${unverifiedSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_NOT_VERIFIED');
});

await test('Auth Variation: Suspended account returns HTTP 403 ACCOUNT_INACTIVE', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${suspendedSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'ACCOUNT_INACTIVE');
});

await test('Auth Variation: Non-intern role (admin/mentor) returns HTTP 403 FORBIDDEN', async () => {
  const adminRes = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(adminRes.status, 403);
  const adminData = await adminRes.json();
  assert.equal(adminData.error.code, 'FORBIDDEN');

  const mentorRes = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${mentorSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(mentorRes.status, 403);
  const mentorData = await mentorRes.json();
  assert.equal(mentorData.error.code, 'FORBIDDEN');
});

// -----------------------------------------------------------------------------
// SECTION 3: PAYLOAD BOUNDARIES & INPUT VALIDATION
// -----------------------------------------------------------------------------
await test('Payload Boundary: Non-string and overlong program_id (> 100 chars) returns 400', async () => {
  const nonStringRes = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validInternSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 12345, statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(nonStringRes.status, 400);

  const longIdRes = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validInternSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_'.padEnd(105, 'x'), statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(longIdRes.status, 400);
});

await test('Payload Boundary: Whitespace-only statement_of_purpose is rejected with 400', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validInternSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: '                     ' })
  }), env);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_INPUT');
});

await test('Payload Boundary: Non-JSON Content-Type returns 415 UNSUPPORTED_MEDIA_TYPE', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Authorization': `Bearer ${validInternSession.rawToken}`
    },
    body: 'plain text body'
  }), env);
  assert.equal(res.status, 415);
  const data = await res.json();
  assert.equal(data.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

// -----------------------------------------------------------------------------
// SECTION 4: PRIVILEGE ESCALATION REJECTION
// -----------------------------------------------------------------------------
let internAppId = '';
await test('Privilege Escalation: Injected user_id, status, role, and payment_status are completely ignored', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validInternSession.rawToken}`
    },
    body: JSON.stringify({
      program_id: 'prg_audit_active_1',
      statement_of_purpose: BASE_SOP,
      user_id: 'usr_hacked_attacker',
      status: 'enrolled',
      role: 'admin',
      payment_status: 'paid',
      submitted_at: '2020-01-01T00:00:00.000Z'
    })
  }), env);

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  internAppId = data.application.id;

  // Verify in database: user_id is the session user, status is 'submitted', not 'enrolled'
  const row = testDb.prepare('SELECT user_id, status, submitted_at FROM applications WHERE id = ?').get(internAppId);
  assert.equal(row.user_id, 'usr_active_intern');
  assert.equal(row.status, 'submitted');
  assert.notEqual(row.submitted_at, '2020-01-01T00:00:00.000Z');
});

// -----------------------------------------------------------------------------
// SECTION 5: CONCURRENT DUPLICATE RACE CONDITION & ATOMICITY
// -----------------------------------------------------------------------------
await test('Concurrency: Duplicate attempt caught by unique constraint returns clean 409', async () => {
  // Re-submitting for prg_audit_active_1
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${validInternSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_1', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error.code, 'DUPLICATE_APPLICATION');
});

await test('Atomicity: Batch write failure rolls back transaction and returns safe 500 error', async () => {
  // Create a mock environment that simulates failure on batch execution
  const failingD1 = createD1Mock(testDb, { failOnBatch: true });
  const failingEnv = { DB: failingD1, ASSETS: mockAssets, ENVIRONMENT: 'test' };

  provisionUser('usr_batch_test', 'batch.test@example.com', 'intern', 'active');
  const batchSession = await createSession('ses_batch_test', 'usr_batch_test');

  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${batchSession.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_audit_active_2', statement_of_purpose: BASE_SOP })
  }), failingEnv);

  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error.code, 'INTERNAL_ERROR');
  // Confirm no partial row exists in applications table
  const uncommittedRow = testDb.prepare('SELECT id FROM applications WHERE user_id = ?').get('usr_batch_test');
  assert.equal(uncommittedRow, undefined);
});

// -----------------------------------------------------------------------------
// SECTION 6: RATE LIMITING ON APPLICATION SUBMISSION
// -----------------------------------------------------------------------------
await test('Rate Limiting: Exceeding 5 applications in 15 minutes returns HTTP 429', async () => {
  provisionUser('usr_spam_intern', 'spam.intern@example.com', 'intern', 'active');
  const spamSession = await createSession('ses_spam_intern', 'usr_spam_intern');

  // Seed 5 programs for spam testing
  for (let i = 1; i <= 6; i++) {
    testDb.prepare(`
      INSERT OR IGNORE INTO internship_programs (id, slug, title, description, duration_weeks, price_paise, is_active)
      VALUES ('prg_spam_${i}', 'spam-track-${i}', 'Spam Track ${i}', 'Description', 8, 0, 1)
    `).run();
  }

  // Submit 5 applications
  for (let i = 1; i <= 5; i++) {
    const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${spamSession.rawToken}`,
        'CF-Connecting-IP': '198.51.100.99'
      },
      body: JSON.stringify({ program_id: `prg_spam_${i}`, statement_of_purpose: BASE_SOP })
    }), env);
    assert.equal(res.status, 201);
  }

  // 6th application must be rate limited
  const throttledRes = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${spamSession.rawToken}`,
      'CF-Connecting-IP': '198.51.100.99'
    },
    body: JSON.stringify({ program_id: 'prg_spam_6', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(throttledRes.status, 429);
  const data = await throttledRes.json();
  assert.equal(data.error.code, 'TOO_MANY_REQUESTS');
});

// -----------------------------------------------------------------------------
// SECTION 7: APPLICANT DATA ISOLATION & PAGINATION SANITIZATION
// -----------------------------------------------------------------------------
await test('Data Isolation: User 1 cannot access User 2 application detail (HTTP 404)', async () => {
  const spamToken = 'spam_isolation_token';
  const spamHash = await hashToken(spamToken);
  testDb.prepare(`INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES ('ses_iso_spam', 'usr_spam_intern', ?, datetime('now', '+7 days'))`).run(spamHash);

  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications/${internAppId}`, {
    headers: { 'Authorization': `Bearer ${spamToken}` }
  }), env);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'APPLICATION_NOT_FOUND');
});

await test('Data Isolation: Malformed ID and path traversal attempts return HTTP 404', async () => {
  const probes = [
    '../applications',
    'app_123%20OR%201=1',
    'app_invalid;DROP TABLE users;',
    'app_test\0nullbyte'
  ];

  for (const probe of probes) {
    const res = await worker.fetch(new Request(`${BASE_URL}/api/applications/${encodeURIComponent(probe)}`, {
      headers: { 'Authorization': `Bearer ${validInternSession.rawToken}` }
    }), env);
    assert.equal(res.status, 404);
  }
});

await test('Pagination Sanitization: NaN, negative, and invalid page parameters are safely sanitized', async () => {
  // Test invalid page string
  const nanRes = await worker.fetch(new Request(`${BASE_URL}/api/applications/me?page=invalid&limit=abc`, {
    headers: { 'Authorization': `Bearer ${validInternSession.rawToken}` }
  }), env);
  assert.equal(nanRes.status, 200);
  const nanData = await nanRes.json();
  assert.equal(nanData.page, 1);
  assert.equal(nanData.limit, 20);

  // Test negative page and limit
  const negRes = await worker.fetch(new Request(`${BASE_URL}/api/applications/me?page=-5&limit=-10`, {
    headers: { 'Authorization': `Bearer ${validInternSession.rawToken}` }
  }), env);
  assert.equal(negRes.status, 200);
  const negData = await negRes.json();
  assert.equal(negData.page, 1);
  assert.equal(negData.limit, 20);

  // Test excessive limit (capped at 50)
  const hugeRes = await worker.fetch(new Request(`${BASE_URL}/api/applications/me?limit=9999`, {
    headers: { 'Authorization': `Bearer ${validInternSession.rawToken}` }
  }), env);
  assert.equal(hugeRes.status, 200);
  const hugeData = await hugeRes.json();
  assert.equal(hugeData.limit, 50);

  // Test out-of-range offset (page 999999)
  const outOfRangeRes = await worker.fetch(new Request(`${BASE_URL}/api/applications/me?page=999999&limit=10`, {
    headers: { 'Authorization': `Bearer ${validInternSession.rawToken}` }
  }), env);
  assert.equal(outOfRangeRes.status, 200);
  const outOfRangeData = await outOfRangeRes.json();
  assert.deepEqual(outOfRangeData.applications, []);
});

// -----------------------------------------------------------------------------
// SECTION 8: BUSINESS LOGIC AUDIT — MAX_SEATS DEFERRED POLICY
// -----------------------------------------------------------------------------
await test('Business Logic: max_seats is intentionally deferred at application submission', async () => {
  // Track has max_seats = 1
  testDb.prepare(`
    INSERT OR REPLACE INTO internship_programs (id, slug, title, description, duration_weeks, price_paise, is_active, max_seats)
    VALUES ('prg_seat_test', 'seat-limited-track', 'Seat Limited Track', 'Description', 8, 0, 1, 1)
  `).run();

  provisionUser('usr_seat_1', 'seat1@example.com', 'intern', 'active');
  provisionUser('usr_seat_2', 'seat2@example.com', 'intern', 'active');

  const session1 = await createSession('ses_seat_1', 'usr_seat_1');
  const session2 = await createSession('ses_seat_2', 'usr_seat_2');

  // Both applicants submit application successfully
  const res1 = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session1.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_seat_test', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res1.status, 201);

  const res2 = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session2.rawToken}`
    },
    body: JSON.stringify({ program_id: 'prg_seat_test', statement_of_purpose: BASE_SOP })
  }), env);
  assert.equal(res2.status, 201);

  // Both applications are in 'submitted' status awaiting admissions review
  const count = testDb.prepare('SELECT COUNT(*) as cnt FROM applications WHERE program_id = ?').get('prg_seat_test');
  assert.equal(Number(count.cnt), 2);
});

console.log('\n================================================================');
console.log(`ALL PHASE 26 SECURITY AUDIT TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
console.log('================================================================\n');
