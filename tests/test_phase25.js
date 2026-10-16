/**
 * Nexora Nexus — Phase 25 Secure Internship Application API Test Suite
 *
 * Verifies:
 * 1. GET /api/programs returns empty list when no active programs exist.
 * 2. GET /api/programs returns only published, active programs (is_active = 1) in stable title order.
 * 3. Anonymous and unverified (pending_verification) applicants are rejected from applying.
 * 4. Successful application creation for an eligible verified applicant.
 * 5. Server-derived field enforcement (client cannot override user_id, status, role, or payment_status).
 * 6. Program validation: invalid or unpublished program IDs return 404 PROGRAM_NOT_FOUND.
 * 7. Duplicate prevention: second application to the same program returns 409 DUPLICATE_APPLICATION.
 * 8. Cross-user isolation on GET /api/applications/me and GET /api/applications/:id.
 * 9. Applicant A cannot read Applicant B's application (returns 404 without data leak).
 * 10. Pagination and stable result ordering on GET /api/applications/me.
 * 11. Security edge cases: Malformed JSON, oversized payloads, unsupported methods, CSRF enforcement.
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

const mockAssets = {
  fetch: async () => new Response('Mock Asset', { status: 200 })
};

const BASE_URL = 'https://vantixnexustech-com.abssnexus.workers.dev';
const env = { DB: d1, ASSETS: mockAssets, ENVIRONMENT: 'test' };

console.log('\n================================================================');
console.log('--- PHASE 25 SECURE INTERNSHIP APPLICATION API TEST SUITE ---');
console.log('================================================================\n');

// 1. GET /api/programs (Empty State)
await test('Programs Catalog: Returns empty array when no programs are published', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/programs`), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.deepEqual(data.programs, []);
});

// Seed Programs
testDb.prepare(`
  INSERT INTO internship_programs (id, slug, title, description, duration_weeks, mode, price_paise, currency, is_active, max_seats)
  VALUES
    ('prg_fullstack_2026', 'full-stack-web-development', 'Full Stack Web Development', 'Comprehensive full stack engineering program.', 8, 'remote', 0, 'INR', 1, 50),
    ('prg_cloud_2026', 'cloud-devops', 'Cloud Computing & DevOps', 'Hands-on Cloud infrastructure and CI/CD pipelines.', 10, 'remote', 0, 'INR', 1, 30),
    ('prg_inactive_archived', 'legacy-track', 'Archived Legacy Track', 'Old unpublished track.', 4, 'remote', 0, 'INR', 0, 10)
`).run();

// 2. GET /api/programs (Filtered & Ordered)
let publishedPrograms = [];
await test('Programs Catalog: Returns only active programs in alphabetical order without fabricating data', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/programs`), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.programs.length, 2);

  // Inactive program must not be returned
  const slugs = data.programs.map(p => p.slug);
  assert.ok(slugs.includes('cloud-devops'));
  assert.ok(slugs.includes('full-stack-web-development'));
  assert.ok(!slugs.includes('legacy-track'));

  // Stable ordering check: 'Cloud Computing & DevOps' precedes 'Full Stack Web Development'
  assert.equal(data.programs[0].slug, 'cloud-devops');
  assert.equal(data.programs[1].slug, 'full-stack-web-development');

  publishedPrograms = data.programs;
});

await test('Programs Catalog: Unsupported method (POST /api/programs) returns 405 Method Not Allowed', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/programs`, { method: 'POST' }), env);
  assert.equal(res.status, 405);
  const data = await res.json();
  assert.equal(data.error.code, 'METHOD_NOT_ALLOWED');
});

// Setup Applicants
const APPLICANT_ALICE = 'alice.intern@nexoranexus.com';
const APPLICANT_BOB = 'bob.intern@nexoranexus.com';
const UNVERIFIED_CHARLIE = 'charlie.unverified@nexoranexus.com';
const ADMIN_USER = 'admin.audit@nexoranexus.com';
const PASSWORD = 'ValidPassword2026!';

// Register Alice (active)
await worker.fetch(new Request(`${BASE_URL}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: APPLICANT_ALICE, password: PASSWORD, full_name: 'Alice Applicant' })
}), env);
await activateUserStatus(d1, APPLICANT_ALICE, 'active');

// Register Bob (active)
await worker.fetch(new Request(`${BASE_URL}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: APPLICANT_BOB, password: PASSWORD, full_name: 'Bob Applicant' })
}), env);
await activateUserStatus(d1, APPLICANT_BOB, 'active');

// Register Charlie (remains pending_verification)
await worker.fetch(new Request(`${BASE_URL}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: UNVERIFIED_CHARLIE, password: PASSWORD, full_name: 'Charlie Unverified' })
}), env);

// Login Alice to obtain session cookie
const aliceLoginRes = await worker.fetch(new Request(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: APPLICANT_ALICE, password: PASSWORD })
}), env);
const aliceCookie = aliceLoginRes.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

// Login Bob to obtain session cookie
const bobLoginRes = await worker.fetch(new Request(`${BASE_URL}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: APPLICANT_BOB, password: PASSWORD })
}), env);
const bobCookie = bobLoginRes.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/)[1];

// Create an unverified session manually for Charlie to test pending_verification guard on application submission
const charlieUser = testDb.prepare('SELECT id FROM users WHERE email = ?').get(UNVERIFIED_CHARLIE);
const charlieToken = 'charlie_test_token_12345';
const charlieTokenHash = await hashToken(charlieToken);
testDb.prepare(`
  INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
  VALUES ('ses_charlie', ?, ?, datetime('now', '+7 days'))
`).run(charlieUser.id, charlieTokenHash);

// 3. Anonymous & Unverified Rejection
await test('Application Guard: Anonymous submission is rejected with HTTP 401', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      program_id: publishedPrograms[0].id,
      statement_of_purpose: 'I am highly interested in joining the cloud engineering track.'
    })
  }), env);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'UNAUTHORIZED');
});

await test('Application Guard: Unverified (pending_verification) applicant is rejected with HTTP 403', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${charlieToken}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: publishedPrograms[0].id,
      statement_of_purpose: 'I am highly interested in joining the cloud engineering track.'
    })
  }), env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'EMAIL_NOT_VERIFIED');
});

// 4. Input Validation
await test('Application Validation: Missing program_id returns HTTP 400', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      statement_of_purpose: 'I am highly interested in joining the cloud engineering track.'
    })
  }), env);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_INPUT');
});

await test('Application Validation: statement_of_purpose under 20 chars returns HTTP 400', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: publishedPrograms[0].id,
      statement_of_purpose: 'Too short'
    })
  }), env);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_INPUT');
});

await test('Application Validation: Non-existent program ID returns HTTP 404', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: 'prg_non_existent_9999',
      statement_of_purpose: 'I would like to apply to this non existent track please.'
    })
  }), env);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'PROGRAM_NOT_FOUND');
});

await test('Application Validation: Inactive / unpublished program ID returns HTTP 404', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: 'prg_inactive_archived',
      statement_of_purpose: 'I would like to apply to this inactive archived track.'
    })
  }), env);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'PROGRAM_NOT_FOUND');
});

// 5. Successful Application Creation & Server-Derived Values
let aliceAppId = '';
const VALID_SOP = 'I am deeply enthusiastic about software development and eager to contribute to production web systems.';

await test('Application Creation: Eligible applicant successfully creates application with server-derived values', async () => {
  const targetProgram = publishedPrograms[0];

  // Client attempts to supply unauthorized fields: status='approved', user_id='usr_hacked', payment_status='paid'
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: targetProgram.id,
      statement_of_purpose: VALID_SOP,
      status: 'approved',
      user_id: 'usr_hacked',
      role: 'admin',
      payment_status: 'paid'
    })
  }), env);

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.application.status, 'submitted');
  assert.equal(data.application.program_id, targetProgram.id);
  assert.ok(data.application.id.startsWith('app_'));

  aliceAppId = data.application.id;

  // Verify in database: user_id is Alice's ID, status is 'submitted', not client override
  const aliceUser = testDb.prepare('SELECT id FROM users WHERE email = ?').get(APPLICANT_ALICE);
  const appRow = testDb.prepare('SELECT * FROM applications WHERE id = ?').get(aliceAppId);

  assert.equal(appRow.user_id, aliceUser.id);
  assert.equal(appRow.status, 'submitted');
  assert.equal(appRow.statement_of_purpose, VALID_SOP);
  assert.ok(appRow.submitted_at);

  // Verify audit event
  const auditRow = testDb.prepare('SELECT action, target_type, target_id FROM audit_events WHERE target_id = ?').get(aliceAppId);
  assert.ok(auditRow);
  assert.equal(auditRow.action, 'application.submitted');
  assert.equal(auditRow.target_type, 'application');
});

// 6. Duplicate Application Prevention
await test('Application Guard: Submitting duplicate application to same program returns HTTP 409', async () => {
  const targetProgram = publishedPrograms[0];

  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: targetProgram.id,
      statement_of_purpose: 'Second attempt to apply to the exact same program.'
    })
  }), env);

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error.code, 'DUPLICATE_APPLICATION');
  assert.ok(data.error.message.includes('already submitted an application'));
});

// 7. Bob Submits to Program 2
let bobAppId = '';
await test('Bob Application: Bob successfully applies to second program', async () => {
  const targetProgram = publishedPrograms[1];

  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${bobCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: targetProgram.id,
      statement_of_purpose: 'Bob application statement of purpose with more than 20 characters.'
    })
  }), env);

  assert.equal(res.status, 201);
  const data = await res.json();
  bobAppId = data.application.id;
});

// 8. Cross-User Isolation on GET /api/applications/me
await test('Cross-User Isolation: GET /api/applications/me returns only the authenticated applicant records', async () => {
  // Alice views applications
  const aliceRes = await worker.fetch(new Request(`${BASE_URL}/api/applications/me`, {
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(aliceRes.status, 200);
  const aliceData = await aliceRes.json();
  assert.equal(aliceData.applications.length, 1);
  assert.equal(aliceData.applications[0].id, aliceAppId);
  assert.notEqual(aliceData.applications[0].id, bobAppId);

  // Bob views applications
  const bobRes = await worker.fetch(new Request(`${BASE_URL}/api/applications/me`, {
    headers: { 'Cookie': `__Host-nexora_session=${bobCookie}` }
  }), env);
  assert.equal(bobRes.status, 200);
  const bobData = await bobRes.json();
  assert.equal(bobData.applications.length, 1);
  assert.equal(bobData.applications[0].id, bobAppId);
  assert.notEqual(bobData.applications[0].id, aliceAppId);
});

// 9. Single Application Detail & Ownership (GET /api/applications/:id)
await test('Application Detail: Applicant reads their own application by ID', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications/${aliceAppId}`, {
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.application.id, aliceAppId);
  assert.equal(data.application.status, 'submitted');
  assert.equal(data.application.program_slug, 'cloud-devops');
});

await test('Ownership Guard: Applicant A cannot read Applicant B application (HTTP 404 without data leak)', async () => {
  // Alice attempts to read Bob's application
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications/${bobAppId}`, {
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.error.code, 'APPLICATION_NOT_FOUND');
});

// 10. Pagination and Stable Result Ordering
await test('Pagination: Correctly pages applications with stable order', async () => {
  // Alice applies to Program 2 as well so she has 2 applications
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: publishedPrograms[1].id,
      statement_of_purpose: 'Alice second application statement for full stack web development.'
    })
  }), env);
  assert.equal(res.status, 201);

  // Request page 1 with limit 1
  const page1Res = await worker.fetch(new Request(`${BASE_URL}/api/applications/me?page=1&limit=1`, {
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(page1Res.status, 200);
  const page1Data = await page1Res.json();
  assert.equal(page1Data.applications.length, 1);
  assert.equal(page1Data.page, 1);
  assert.equal(page1Data.total, 2);

  // Request page 2 with limit 1
  const page2Res = await worker.fetch(new Request(`${BASE_URL}/api/applications/me?page=2&limit=1`, {
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(page2Res.status, 200);
  const page2Data = await page2Res.json();
  assert.equal(page2Data.applications.length, 1);
  assert.equal(page2Data.page, 2);

  // IDs must be distinct across pages
  assert.notEqual(page1Data.applications[0].id, page2Data.applications[0].id);
});

// 11. Security & Edge Cases
await test('Security: Malformed JSON payload returns HTTP 400', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: '{ invalid_json: true '
  }), env);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_JSON');
});

await test('Security: Oversized payload (> 64KB) returns HTTP 413', async () => {
  const largeString = 'A'.repeat(70000);
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify({
      program_id: publishedPrograms[0].id,
      statement_of_purpose: largeString
    })
  }), env);
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error.code, 'PAYLOAD_TOO_LARGE');
});

await test('Security: Unsupported HTTP method on /api/applications returns HTTP 405', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'DELETE',
    headers: { 'Cookie': `__Host-nexora_session=${aliceCookie}` }
  }), env);
  assert.equal(res.status, 405);
  const data = await res.json();
  assert.equal(data.error.code, 'METHOD_NOT_ALLOWED');
});

await test('Security: Mutating request without CSRF custom header is blocked with HTTP 403', async () => {
  const res = await worker.fetch(new Request(`${BASE_URL}/api/applications`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `__Host-nexora_session=${aliceCookie}`
      // Omit X-CSRF-Token and X-Requested-With
    },
    body: JSON.stringify({
      program_id: publishedPrograms[0].id,
      statement_of_purpose: 'CSRF test statement without headers.'
    })
  }), env);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.error.code, 'CSRF_FORBIDDEN');
});

console.log('\n================================================================');
console.log(`ALL PHASE 25 INTERNSHIP APPLICATION API TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
console.log('================================================================\n');
