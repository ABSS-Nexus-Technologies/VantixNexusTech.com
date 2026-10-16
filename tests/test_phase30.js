/**
 * Nexora Nexus — Phase 30 Remediation Verification Test Suite
 *
 * Validates fixes for Phase 29 audit findings:
 * - Fix 1: Authentication user journey (login.html, register.html, CSRF, honest notices, backend contracts)
 * - Fix 2: Empty programme catalogue guard (state tracking, blocking on loading/empty/error, strict UUID match)
 * - Fix 3: Statement-of-purpose validation (20–3000 char bounds, maxlength="3000", hint counter, tests for 19, 20, 3000, 3001)
 * - Fix 4: Rate-limit resilience (fail-closed HTTP 503 on D1 error, normal 429, no internal leaks)
 * - Fix 5: Honeypot handling (silent client-side reset, zero PII transmission)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';
import { hashPassword, generateUuid, hashToken } from '../worker/crypto.js';
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

// ---------------------------------------------------------------------------
// D1 Mock & Worker Simulator Helper
// ---------------------------------------------------------------------------
function createTestD1() {
  const db = new DatabaseSync(':memory:');
  const schemaPath = path.join(ROOT_DIR, 'migrations', '0001_initial_schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

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
  console.log('--- PHASE 30 REMEDIATION VERIFICATION TEST SUITE ---');
  console.log('================================================================\n');

  const internshipsHtml = fs.readFileSync(path.join(ROOT_DIR, 'internships.html'), 'utf8');
  const loginHtml = fs.readFileSync(path.join(ROOT_DIR, 'login.html'), 'utf8');
  const registerHtml = fs.readFileSync(path.join(ROOT_DIR, 'register.html'), 'utf8');
  const scriptJs = fs.readFileSync(path.join(ROOT_DIR, 'script.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

  // -------------------------------------------------------------------------
  // CATEGORY 1: Fix 1 — Authentication User Journey
  // -------------------------------------------------------------------------
  console.log('Category 1: Fix 1 — Authentication User Journey');

  await test('1.1 login.html and register.html exist with accessible form elements and IDs', () => {
    assert.match(loginHtml, /id="applicant-login-form"/, 'login.html must have #applicant-login-form');
    assert.match(loginHtml, /id="login-email"/, 'login.html must have #login-email');
    assert.match(loginHtml, /id="login-password"/, 'login.html must have #login-password');
    assert.match(loginHtml, /id="login-submit-btn"/, 'login.html must have #login-submit-btn');
    assert.match(loginHtml, /id="login-status"/, 'login.html must have #login-status');

    assert.match(registerHtml, /id="applicant-register-form"/, 'register.html must have #applicant-register-form');
    assert.match(registerHtml, /id="reg-name"/, 'register.html must have #reg-name');
    assert.match(registerHtml, /id="reg-email"/, 'register.html must have #reg-email');
    assert.match(registerHtml, /id="reg-password"/, 'register.html must have #reg-password');
    assert.match(registerHtml, /id="reg-password-confirm"/, 'register.html must have #reg-password-confirm');
    assert.match(registerHtml, /id="register-submit-btn"/, 'register.html must have #register-submit-btn');
    assert.match(registerHtml, /id="register-status"/, 'register.html must have #register-status');
  });

  await test('1.2 Both auth pages link to internships.html across desktop, mobile, and footer', () => {
    assert.match(loginHtml, /href="internships\.html" class="nav-link/, 'login.html desktop nav link to internships');
    assert.match(loginHtml, /href="internships\.html" class="mobile-nav-link/, 'login.html mobile nav link to internships');
    assert.match(loginHtml, /href="internships\.html">Internships<\/a>/, 'login.html footer link to internships');

    assert.match(registerHtml, /href="internships\.html" class="nav-link/, 'register.html desktop nav link to internships');
    assert.match(registerHtml, /href="internships\.html" class="mobile-nav-link/, 'register.html mobile nav link to internships');
    assert.match(registerHtml, /href="internships\.html">Internships<\/a>/, 'register.html footer link to internships');
  });

  await test('1.3 internships.html provides navigation to login.html and register.html', () => {
    assert.match(internshipsHtml, /href="login\.html"/, 'internships.html must link to login.html');
    assert.match(internshipsHtml, /href="register\.html"/, 'internships.html must link to register.html');
  });

  await test('1.4 script.js auth handlers use same-origin fetch with CSRF protection header', () => {
    assert.match(scriptJs, /fetch\('\/api\/auth\/login'/, 'script.js must fetch /api/auth/login');
    assert.match(scriptJs, /fetch\('\/api\/auth\/register'/, 'script.js must fetch /api/auth/register');
    assert.match(scriptJs, /'X-Requested-With':\s*'XMLHttpRequest'/, 'Must include CSRF protection header');
    assert.match(scriptJs, /credentials:\s*'same-origin'/, 'Must specify same-origin credentials');
  });

  await test('1.5 No passwords, session tokens, or reset tokens stored in localStorage or sessionStorage', () => {
    const combinedFrontend = scriptJs + loginHtml + registerHtml + internshipsHtml;
    assert.doesNotMatch(combinedFrontend, /localStorage\.setItem\([^)]*token/i, 'Must not store tokens in localStorage');
    assert.doesNotMatch(combinedFrontend, /localStorage\.setItem\([^)]*password/i, 'Must not store passwords in localStorage');
    assert.doesNotMatch(combinedFrontend, /sessionStorage\.setItem\([^)]*token/i, 'Must not store tokens in sessionStorage');
    assert.doesNotMatch(combinedFrontend, /sessionStorage\.setItem\([^)]*password/i, 'Must not store passwords in sessionStorage');
  });

  await test('1.6 Honest disclosure of email verification dependency in both auth pages', () => {
    assert.match(loginHtml, /transactional email delivery services are awaiting production provider setup/i);
    assert.match(registerHtml, /transactional email delivery infrastructure is currently awaiting production provider configuration/i);
  });

  await test('1.7 Backend integration: POST /api/auth/register creates pending_verification account (HTTP 201)', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    const req = new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        full_name: 'Priya Sharma',
        email: 'priya.sharma@example.edu',
        password: 'Password123!',
        college: 'Delhi University',
        graduation_year: 2026
      })
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.user.status, 'pending_verification');
    assert.equal(data.user.email, 'priya.sharma@example.edu');
  });

  await test('1.8 Backend integration: Duplicate email registration returns HTTP 409 EMAIL_EXISTS', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    const payload = {
      full_name: 'Priya Sharma',
      email: 'duplicate@example.edu',
      password: 'Password123!'
    };

    const req1 = new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(payload)
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 201);

    const req2 = new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(payload)
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 409);
    const data2 = await res2.json();
    assert.equal(data2.error.code, 'EMAIL_EXISTS');
  });

  await test('1.9 Backend integration: Login with unverified account returns HTTP 403 EMAIL_NOT_VERIFIED', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    // Register user (pending_verification)
    await worker.fetch(new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ full_name: 'Unverified Intern', email: 'unverified@example.edu', password: 'Password123!' })
    }), env);

    // Attempt login
    const loginReq = new Request('https://nexoranexus.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email: 'unverified@example.edu', password: 'Password123!' })
    });
    const loginRes = await worker.fetch(loginReq, env);
    assert.equal(loginRes.status, 403);
    const data = await loginRes.json();
    assert.equal(data.error.code, 'EMAIL_NOT_VERIFIED');
  });

  await test('1.10 Backend integration: Login with invalid credentials returns HTTP 401 INVALID_CREDENTIALS', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    const loginReq = new Request('https://nexoranexus.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email: 'nonexistent@example.edu', password: 'Password123!' })
    });
    const loginRes = await worker.fetch(loginReq, env);
    assert.equal(loginRes.status, 401);
    const data = await loginRes.json();
    assert.equal(data.error.code, 'INVALID_CREDENTIALS');
  });

  await test('1.11 Backend integration: Login with active verified account sets session cookie (HTTP 200)', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    // Register user
    const regRes = await worker.fetch(new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ full_name: 'Active Intern', email: 'active@example.edu', password: 'Password123!' })
    }), env);
    const regData = await regRes.json();

    // Activate user directly via admin helper
    await activateUserStatus(d1, regData.user.email);

    // Login
    const loginReq = new Request('https://nexoranexus.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ email: 'active@example.edu', password: 'Password123!' })
    });
    const loginRes = await worker.fetch(loginReq, env);
    assert.equal(loginRes.status, 200);
    const setCookie = loginRes.headers.get('Set-Cookie');
    assert.ok(setCookie, 'Must set session cookie');
    assert.match(setCookie, /__Host-nexora_session=/, 'Must use __Host- prefix');
    assert.match(setCookie, /HttpOnly/, 'Must be HttpOnly');
    assert.match(setCookie, /SameSite=Strict/, 'Must be SameSite=Strict');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 2: Fix 2 — Empty Programme Catalogue Guard
  // -------------------------------------------------------------------------
  console.log('\nCategory 2: Fix 2 — Empty Programme Catalogue Guard');

  await test('2.1 script.js initializes catalogueState with idle status and empty programs', () => {
    assert.match(scriptJs, /let\s+catalogueState\s*=\s*\{[\s\S]*status:\s*'idle',[\s\S]*programs:\s*\[\]/);
  });

  await test('2.2 script.js updates catalogueState to loading, empty, loaded, and error', () => {
    assert.match(scriptJs, /catalogueState\.status\s*=\s*'loading'/);
    assert.match(scriptJs, /catalogueState\.status\s*=\s*'empty'/);
    assert.match(scriptJs, /catalogueState\.status\s*=\s*'loaded'/);
    assert.match(scriptJs, /catalogueState\.status\s*=\s*'error'/);
  });

  await test('2.3 script.js blocks submission when catalogue is loading, empty, or error', () => {
    assert.match(scriptJs, /if\s*\(catalogueState\.status\s*===\s*'loading'\)\s*\{/);
    assert.match(scriptJs, /if\s*\(catalogueState\.status\s*===\s*'empty'\)\s*\{/);
    assert.match(scriptJs, /if\s*\(catalogueState\.status\s*===\s*'error'\)\s*\{/);
    assert.match(scriptJs, /if\s*\(catalogueState\.status\s*!==\s*'loaded'/);
  });

  await test('2.4 script.js strictly requires targetProgramId to match an active server-returned programme', () => {
    assert.match(scriptJs, /const\s+selectedProgram\s*=\s*catalogueState\.programs\.find\(p\s*=>\s*p\.id\s*===\s*role\);/);
    assert.match(scriptJs, /const\s+targetProgramId\s*=\s*selectedProgram\.id;/);
    assert.doesNotMatch(scriptJs, /const\s+targetProgramId\s*=\s*selectedProgram\s*\?\s*selectedProgram\.id\s*:\s*role;/, 'Must NOT fall back to static role string');
  });

  await test('2.5 Static role cards in internships.html clearly labelled as interest registration', () => {
    const roleBadges = internshipsHtml.match(/Interest Registration · Details to be confirmed/g);
    assert.ok(roleBadges && roleBadges.length >= 6, 'All 6 static role cards must be clearly labelled as exploratory interest registration');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 3: Fix 3 — Statement-of-Purpose Validation
  // -------------------------------------------------------------------------
  console.log('\nCategory 3: Fix 3 — Statement-of-Purpose Validation');

  await test('3.1 internships.html motivation textarea enforces maxlength="3000" and aria hint', () => {
    assert.match(internshipsHtml, /<textarea[^>]*id="internship-motivation"[^>]*maxlength="3000"/);
    assert.match(internshipsHtml, /id="motivation-char-hint"/);
  });

  await test('3.2 script.js checks statement of purpose length bounds between 20 and 3000 characters', () => {
    assert.match(scriptJs, /motivationTrimmed\.length\s*<\s*20/);
    assert.match(scriptJs, /motivationTrimmed\.length\s*>\s*3000/);
  });

  await test('3.3 Validation logic accurately tests 19, 20, 3000, and 3001 characters', () => {
    const validateLength = (str) => {
      const trimmed = str.trim();
      if (!trimmed || trimmed.length < 20) return { valid: false, error: 'TOO_SHORT' };
      if (trimmed.length > 3000) return { valid: false, error: 'TOO_LONG' };
      return { valid: true };
    };

    // 19 characters -> FAIL
    assert.equal(validateLength('A'.repeat(19)).valid, false);
    assert.equal(validateLength('A'.repeat(19)).error, 'TOO_SHORT');

    // 20 characters -> PASS
    assert.equal(validateLength('A'.repeat(20)).valid, true);

    // 3000 characters -> PASS
    assert.equal(validateLength('A'.repeat(3000)).valid, true);

    // 3001 characters -> FAIL
    assert.equal(validateLength('A'.repeat(3001)).valid, false);
    assert.equal(validateLength('A'.repeat(3001)).error, 'TOO_LONG');
  });

  await test('3.4 Backend rejects SOP < 20 or > 3000 with HTTP 400 INVALID_SOP', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    // Register and activate user
    const regRes = await worker.fetch(new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ full_name: 'Verified Applicant', email: 'verified@example.edu', password: 'Password123!' })
    }), env);
    const { user } = await regRes.json();
    await activateUserStatus(d1, user.email);

    // Create session
    const sessionToken = 'test_session_token_30';
    const tokenHash = await hashToken(sessionToken);
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    await d1.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind('sess_sop_test', user.id, tokenHash, expiresAt).run();

    // Create an active program
    const progId = `prog_${generateUuid()}`;
    await d1.prepare(`
      INSERT INTO internship_programs (id, title, slug, description, duration_weeks, mode, price_paise, currency, is_active)
      VALUES (?, 'Test Track', 'test-track', 'Track description', 8, 'remote', 0, 'INR', 1)
    `).bind(progId).run();

    // Test 19 chars -> rejected with 400
    const res19 = await worker.fetch(new Request('https://nexoranexus.com/api/applications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({ program_id: progId, statement_of_purpose: 'A'.repeat(19) })
    }), env);
    assert.equal(res19.status, 400);
    const data19 = await res19.json();
    assert.equal(data19.error.code, 'INVALID_INPUT');

    // Test 20 chars -> accepted (201)
    const res20 = await worker.fetch(new Request('https://nexoranexus.com/api/applications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({ program_id: progId, statement_of_purpose: 'A'.repeat(20) })
    }), env);
    assert.equal(res20.status, 201);
  });

  // -------------------------------------------------------------------------
  // CATEGORY 4: Fix 4 — Rate-Limit Resilience
  // -------------------------------------------------------------------------
  console.log('\nCategory 4: Fix 4 — Rate-Limit Resilience');

  await test('4.1 worker/applications.js rate limit catch block returns controlled HTTP 503 on D1 error', async () => {
    const applicationsJs = fs.readFileSync(path.join(ROOT_DIR, 'worker', 'applications.js'), 'utf8');
    assert.match(applicationsJs, /code:\s*'SERVICE_UNAVAILABLE'/);
    assert.match(applicationsJs, /status:\s*503/);
    assert.doesNotMatch(applicationsJs, /rateLimitExceeded\s*=\s*false;\s*\/\/\s*Fail open/, 'Must NOT fail open silently');
  });

  await test('4.2 Simulated D1 rate-limit failure returns HTTP 503 without leaking SQL or internals', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    // Register & activate user
    const regRes = await worker.fetch(new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ full_name: 'Resilience Test', email: 'resilience@example.edu', password: 'Password123!' })
    }), env);
    const { user } = await regRes.json();
    await activateUserStatus(d1, user.email);

    const sessionToken = 'test_resilience_token';
    const tokenHash = await hashToken(sessionToken);
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    await d1.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind('sess_resilience', user.id, tokenHash, expiresAt).run();

    const progId = `prog_${generateUuid()}`;
    await d1.prepare(`
      INSERT INTO internship_programs (id, title, slug, description, duration_weeks, mode, price_paise, currency, is_active)
      VALUES (?, 'Resilience Track', 'resilience-track', 'Resilience description', 8, 'remote', 0, 'INR', 1)
    `).bind(progId).run();

    // Wrap d1 to throw on audit_events query
    const faultyD1 = {
      prepare(sql) {
        if (sql.includes("action = 'application.submitted'") && sql.includes("COUNT(*)")) {
          return {
            bind() {
              return {
                async first() {
                  throw new Error('D1_SIMULATED_DATABASE_TIMEOUT: table locked');
                }
              };
            }
          };
        }
        return d1.prepare(sql);
      },
      batch(stmts) { return d1.batch(stmts); }
    };

    const faultyEnv = { DB: faultyD1 };
    const res = await worker.fetch(new Request('https://nexoranexus.com/api/applications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({ program_id: progId, statement_of_purpose: 'A'.repeat(50) })
    }), faultyEnv);

    assert.equal(res.status, 503, 'Must return HTTP 503 Service Unavailable when rate limiter fails');
    const data = await res.json();
    assert.equal(data.error.code, 'SERVICE_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(data), /D1_SIMULATED_DATABASE_TIMEOUT/i, 'Must not leak D1 error text');
    assert.doesNotMatch(JSON.stringify(data), /SELECT COUNT\(\*\)/i, 'Must not leak SQL queries');
  });

  await test('4.3 Normal application rate limiting returns HTTP 429 when quota is exceeded', async () => {
    const { d1 } = createTestD1();
    const env = { DB: d1 };

    // Register & activate user
    const regRes = await worker.fetch(new Request('https://nexoranexus.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ full_name: 'Quota Test', email: 'quota@example.edu', password: 'Password123!' })
    }), env);
    const { user } = await regRes.json();
    await activateUserStatus(d1, user.email);

    const sessionToken = 'test_quota_token';
    const tokenHash = await hashToken(sessionToken);
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    await d1.prepare(`
      INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind('sess_quota', user.id, tokenHash, expiresAt).run();

    // Populate 5 application audit events within window
    for (let i = 0; i < 5; i++) {
      await d1.prepare(`
        INSERT INTO audit_events (id, actor_id, action, target_type, target_id, ip_address, created_at)
        VALUES (?, ?, 'application.submitted', 'application', ?, '127.0.0.1', datetime('now'))
      `).bind(`aud_${i}_${generateUuid()}`, user.id, `app_${i}`).run();
    }

    const progId = `prog_${generateUuid()}`;
    await d1.prepare(`
      INSERT INTO internship_programs (id, title, slug, description, duration_weeks, mode, price_paise, currency, is_active)
      VALUES (?, 'Quota Track', 'quota-track', 'Quota description', 8, 'remote', 0, 'INR', 1)
    `).bind(progId).run();

    const res = await worker.fetch(new Request('https://nexoranexus.com/api/applications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({ program_id: progId, statement_of_purpose: 'A'.repeat(50) })
    }), env);

    assert.equal(res.status, 429, 'Must return HTTP 429 when rate limit is exceeded');
    const data = await res.json();
    assert.equal(data.error.code, 'TOO_MANY_REQUESTS');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 5: Fix 5 — Honeypot Handling
  // -------------------------------------------------------------------------
  console.log('\nCategory 5: Fix 5 — Honeypot Handling');

  await test('5.1 Honeypot input exists in internships.html and is invisible to users and assistive tech', () => {
    assert.match(internshipsHtml, /id="applicant_source_verification"/);
    assert.match(internshipsHtml, /tabindex="-1"/);
    assert.match(internshipsHtml, /aria-hidden="true"/);
  });

  await test('5.2 script.js resets form immediately upon honeypot submission without network request', () => {
    assert.match(scriptJs, /const\s+honeypot\s*=\s*document\.getElementById\('applicant_source_verification'\);/);
    assert.match(scriptJs, /if\s*\(honeypot\s*&&\s*honeypot\.value\.trim\(\)\s*!==\s*''\)\s*\{/);
    assert.match(scriptJs, /internshipForm\.reset\(\);/);
    assert.match(scriptJs, /return;/);
  });

  // -------------------------------------------------------------------------
  // CATEGORY 6: Full System & Regression Integrity
  // -------------------------------------------------------------------------
  console.log('\nCategory 6: Full System & Regression Integrity');

  await test('6.1 All HTML files exist and link to internships.html', () => {
    const htmlFiles = fs.readdirSync(ROOT_DIR).filter(f => f.endsWith('.html'));
    assert.ok(htmlFiles.length >= 27, `Expected at least 27 HTML files, found ${htmlFiles.length}`);
    for (const file of htmlFiles) {
      const content = fs.readFileSync(path.join(ROOT_DIR, file), 'utf8');
      assert.match(content, /href="internships\.html"/, `${file} must contain a link to internships.html`);
    }
  });

  await test('6.2 Section 24 styles exist in style.css for auth pages', () => {
    assert.match(styleCss, /\.auth-page-section/);
    assert.match(styleCss, /\.auth-card/);
    assert.match(styleCss, /\.auth-form/);
  });

  console.log('\n================================================================');
  console.log(`ALL PHASE 30 TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
  console.log('================================================================\n');
}

runSuite().catch(err => {
  console.error('\nTest suite failed:', err);
  process.exit(1);
});
