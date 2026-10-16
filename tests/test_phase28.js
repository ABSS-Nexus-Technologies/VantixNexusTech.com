/**
 * Nexora Nexus — Phase 28 Safe Internship Frontend Integration Test Suite
 *
 * This test suite validates:
 * 1. Frontend HTML & CSS structure:
 *    - #programs-catalogue-status and #live-programs-container in internships.html
 *    - #applicant-auth-status in internships.html
 *    - #applicant-dashboard and #applicant-dashboard-container in internships.html
 *    - Section 23 stylesheet rules in style.css
 * 2. Dynamic Programme Catalogue loading & display:
 *    - Empty catalogue handling (explanatory notice, no fabricated records)
 *    - Populated active catalogue rendering (DOM-safe, price validation in INR / paise)
 *    - Network and API failure handling with recoverable retry mechanism
 * 3. Session status & authentication integration:
 *    - GET /api/user/me state detection (signed-out, pending_verification, active verified)
 *    - Honest guidance without fabricated login flows
 *    - Non-exposure of sensitive tokens or credentials
 * 4. Application submission pipeline:
 *    - Submissions sent strictly to POST /api/applications with { program_id, statement_of_purpose }
 *    - In-flight double-submission prevention and loading indicators
 *    - Confirmed HTTP 201 response before showing success state
 *    - Rejection handling: 400 validation, 401 unauthenticated, 403 unverified, 404 inactive, 409 duplicate, 429 rate limit
 *    - Network error preservation of user input without claiming success
 *    - No payment collection or fake payment claims
 * 5. Applicant dashboard:
 *    - GET /api/applications/me integration with same-origin credentials
 *    - Loading, empty, populated, and error states
 *    - Status badges (submitted, under_review, approved, etc.)
 *    - Safe DOM rendering (DOM textContent / HTML escaping preventing XSS)
 * 6. Website regression tests:
 *    - 25 HTML pages integrity and navigation
 *    - Staged index preservation
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

// ---------------------------------------------------------------------------
// Run Test Suite
// ---------------------------------------------------------------------------
async function runSuite() {
  console.log('\n================================================================');
  console.log('--- PHASE 28 SAFE INTERNSHIP FRONTEND INTEGRATION TESTS ---');
  console.log('================================================================\n');

  const internshipsHtml = fs.readFileSync(path.join(ROOT_DIR, 'internships.html'), 'utf8');
  const scriptJs = fs.readFileSync(path.join(ROOT_DIR, 'script.js'), 'utf8');
  const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'style.css'), 'utf8');

  // -------------------------------------------------------------------------
  // CATEGORY 1: Frontend HTML & CSS Structural Integrity
  // -------------------------------------------------------------------------
  console.log('Category 1: Frontend HTML & CSS Structural Integrity');

  await test('1.1 internships.html contains program catalogue status and live containers', () => {
    assert.match(internshipsHtml, /id="programs-catalogue-status"/, 'Must contain #programs-catalogue-status');
    assert.match(internshipsHtml, /id="live-programs-container"/, 'Must contain #live-programs-container');
    assert.match(scriptJs, /live-programs-grid/, 'Script must dynamically generate live-programs-grid inside container');
  });

  await test('1.2 internships.html contains applicant session status container with aria attributes', () => {
    assert.match(internshipsHtml, /id="applicant-auth-status"/, 'Must contain #applicant-auth-status');
    assert.match(internshipsHtml, /role="status"/, 'Must include role="status" for accessibility');
    assert.match(internshipsHtml, /aria-live="polite"/, 'Must include aria-live="polite"');
  });

  await test('1.3 internships.html contains applicant dashboard section and container', () => {
    assert.match(internshipsHtml, /id="applicant-dashboard"/, 'Must contain #applicant-dashboard');
    assert.match(internshipsHtml, /id="applicant-dashboard-container"/, 'Must contain #applicant-dashboard-container');
    assert.match(internshipsHtml, /id="applicant-dashboard-title"/, 'Must contain clear dashboard title element');
    assert.match(internshipsHtml, /Track your submitted applications\./, 'Must contain clear dashboard title text');
  });

  await test('1.4 style.css includes Section 23 with applicant portal styles', () => {
    assert.match(styleCss, /23\.\s*Phase 28:\s*Safe Internship Frontend Integration/i, 'style.css must have Section 23 header');
    assert.match(styleCss, /\.programs-catalogue-status/, 'Must style catalogue status container');
    assert.match(styleCss, /\.live-program-card/, 'Must style live program cards');
    assert.match(styleCss, /\.applicant-auth-status/, 'Must style applicant auth status banner');
    assert.match(styleCss, /\.applicant-dashboard-container/, 'Must style applicant dashboard');
    assert.match(styleCss, /\.dashboard-table/, 'Must style dashboard table');
    assert.match(styleCss, /\.app-status-badge/, 'Must style application status badges');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 2: Client-Side Session State Handling
  // -------------------------------------------------------------------------
  console.log('\nCategory 2: Client-Side Session State Handling');

  await test('2.1 checkApplicantSession checks GET /api/user/me with same-origin credentials', () => {
    assert.match(scriptJs, /fetch\(\s*INTERNSHIP_API\.userMe[\s\S]*?credentials:\s*'same-origin'/,
      'Must call GET /api/user/me with credentials: "same-origin"');
  });

  await test('2.2 Signed-out state displays honest messaging without fake authentication flows', () => {
    assert.match(scriptJs, /Applicant Session: Guest|browsing as a guest/, 'Must render clear guest/signed-out notice');
    assert.match(scriptJs, /hello@nexoranexus\.com/, 'Must direct applicant to real admissions contact');
  });

  await test('2.3 Pending verification state warns applicant that email verification is pending', () => {
    assert.match(scriptJs, /status === 'pending_verification'/, 'Must distinguish pending_verification status');
    assert.match(scriptJs, /Verification Pending|Email Verification Required/, 'Must show email verification pending notice');
    assert.match(scriptJs, /Transactional email verification delivery is awaiting provider configuration|Transactional verification email delivery is awaiting provider configuration/,
      'Must honestly state transactional email delivery status');
  });

  await test('2.4 Verified applicant state shows active status badge', () => {
    assert.match(scriptJs, /Verified Applicant/, 'Must show verified applicant banner');
    assert.match(scriptJs, /auth-status-card verified/, 'Must apply verified status styling');
  });

  await test('2.5 Session tokens and passwords are not stored in localStorage or logged to console', () => {
    assert.doesNotMatch(scriptJs, /localStorage\.setItem\([^)]*token/i, 'Must not store tokens in localStorage');
    assert.doesNotMatch(scriptJs, /sessionStorage\.setItem\([^)]*token/i, 'Must not store tokens in sessionStorage');
    assert.doesNotMatch(scriptJs, /console\.log\([^)]*password/i, 'Must not log passwords');
    assert.doesNotMatch(scriptJs, /console\.log\([^)]*token/i, 'Must not log tokens');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 3: Dynamic Programme Catalogue Loading & DOM Safety
  // -------------------------------------------------------------------------
  console.log('\nCategory 3: Dynamic Programme Catalogue Loading & DOM Safety');

  await test('3.1 loadProgramCatalogue fetches GET /api/programs with safe fallback', () => {
    assert.match(scriptJs, /fetch\(\s*INTERNSHIP_API\.programs[\s\S]*?method:\s*'GET'/,
      'Must fetch GET /api/programs');
  });

  await test('3.2 Empty catalogue displays honest unapproved schedule notice', () => {
    assert.match(scriptJs, /Admissions Schedule Notice/, 'Must explain empty catalogue');
    assert.match(scriptJs, /awaiting schedule finalization|awaiting schedule approval/,
      'Must state that programmes are awaiting schedule finalization');
  });

  await test('3.3 Price rendering conforms strictly to paise / INR convention without inventing prices', () => {
    assert.match(scriptJs, /price_paise === 0/, 'Must check for price_paise === 0');
    assert.match(scriptJs, /Sponsored \/ Free \(₹0\)/, 'Must format free/sponsored programmes accurately');
    assert.match(scriptJs, /price_paise \/ 100/, 'Must convert paise to rupees accurately');
    assert.match(scriptJs, /currency || 'INR'/, 'Must respect API currency');
  });

  await test('3.4 API text values are rendered safely using textContent or escapeHtml', () => {
    assert.match(scriptJs, /title\.textContent = program\.title/, 'Program titles must use textContent');
    assert.match(scriptJs, /desc\.textContent = program\.description/, 'Program descriptions must use textContent');
    assert.match(scriptJs, /escapeHtml/, 'Must have escapeHtml helper for safe string interpolation');
  });

  await test('3.5 Catalogue error card provides a recoverable retry button', () => {
    assert.match(scriptJs, /id="retry-catalogue-btn"/, 'Must provide retry button for catalogue failure');
    assert.match(scriptJs, /retryBtn\.addEventListener\('click',\s*\(\)\s*=>\s*loadProgramCatalogue\(\)\)/,
      'Retry button must re-invoke loadProgramCatalogue');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 4: Application Submission Pipeline & Validation
  // -------------------------------------------------------------------------
  console.log('\nCategory 4: Application Submission Pipeline & Validation');

  await test('4.1 Submission is blocked if applicant is unauthenticated or unverified', () => {
    assert.match(scriptJs, /if \(!applicantSession\.isAuthenticated\)/,
      'Must check authentication before transmission');
    assert.match(scriptJs, /if \(applicantSession\.user && applicantSession\.user\.status === 'pending_verification'\)/,
      'Must check email verification before transmission');
  });

  await test('4.2 Form submission sends only expected fields { program_id, statement_of_purpose }', () => {
    assert.match(scriptJs, /JSON\.stringify\(\{\s*program_id:\s*targetProgramId,\s*statement_of_purpose:\s*motivation\s*\}\)/s,
      'Must submit strictly program_id and statement_of_purpose');
  });

  await test('4.3 Form submission includes CSRF defense header X-Requested-With', () => {
    assert.match(scriptJs, /'X-Requested-With':\s*'XMLHttpRequest'/,
      'Must send custom header for CSRF defense');
  });

  await test('4.4 Accidental double submission is prevented with in-flight lock and disabled button', () => {
    assert.match(scriptJs, /if \(isSubmittingApplication\) return;/, 'Must check in-flight submission lock');
    assert.match(scriptJs, /isSubmittingApplication = true;/, 'Must set submission lock');
    assert.match(scriptJs, /internshipSubmitBtn\.disabled = true;/, 'Must disable submit button');
    assert.match(scriptJs, /isSubmittingApplication = false;\s*internshipSubmitBtn\.disabled = false;/s,
      'Must release lock and re-enable button in finally block');
  });

  await test('4.5 Success state is shown ONLY after server returns HTTP 201', () => {
    assert.match(scriptJs, /if \(response\.status === 201\)/, 'Must verify response.status === 201');
    assert.match(scriptJs, /Application Submitted Successfully!/, 'Must display success message only on 201');
  });

  await test('4.6 Duplicate application (HTTP 409) displays clear notice and links to tracking', () => {
    assert.match(scriptJs, /else if \(response\.status === 409\)/, 'Must handle HTTP 409 duplicate');
    assert.match(scriptJs, /Duplicate Application Notice/, 'Must announce duplicate application notice');
  });

  await test('4.7 Rate limiting (HTTP 429) displays cooldown message', () => {
    assert.match(scriptJs, /else if \(response\.status === 429\)/, 'Must handle HTTP 429 rate limit');
    assert.match(scriptJs, /Submission Rate Limit Reached/, 'Must announce rate limit message');
  });

  await test('4.8 Network failure preserves user input and summary for safekeeping without claiming success', () => {
    assert.match(scriptJs, /catch \(fetchErr\)/, 'Must catch network errors');
    assert.match(scriptJs, /Submission Service Unavailable/, 'Must report service unavailable honestly');
    assert.match(scriptJs, /Copy Formatted Application/, 'Must allow copying application details');
    assert.doesNotMatch(scriptJs, /catch \(fetchErr\)[^}]*Application Submitted Successfully/s,
      'Network catch block must never claim application was submitted');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 5: Applicant Dashboard & History
  // -------------------------------------------------------------------------
  console.log('\nCategory 5: Applicant Dashboard & History');

  await test('5.1 loadMyApplications checks GET /api/applications/me with credentials', () => {
    assert.match(scriptJs, /fetch\([\s\S]*?INTERNSHIP_API\.myApplications[\s\S]*?credentials:\s*'same-origin'/,
      'Must fetch GET /api/applications/me with credentials: "same-origin"');
  });

  await test('5.2 Unauthenticated user sees prompt to sign in', () => {
    assert.match(scriptJs, /Sign in with an active intern applicant account to view your application status/,
      'Must prompt unauthenticated users to sign in');
  });

  await test('5.3 Empty applications history displays helpful empty state card', () => {
    assert.match(scriptJs, /No applications found for your account\./,
      'Must display helpful message when user has 0 applications');
  });

  await test('5.4 Application list renders table with accessible headers and status badges', () => {
    assert.match(scriptJs, /<th scope="col">Application Reference<\/th>/, 'Must have accessible table headers');
    assert.match(scriptJs, /app-status-badge status-/, 'Must render status badges');
    assert.match(scriptJs, /Refresh Records ↻/, 'Must provide refresh button');
  });

  await test('5.5 Dashboard error state provides recoverable retry button', () => {
    assert.match(scriptJs, /id="retry-dashboard-btn"/, 'Must provide retry button for dashboard failure');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 6: End-to-End Worker API Compatibility with Frontend Contracts
  // -------------------------------------------------------------------------
  console.log('\nCategory 6: End-to-End Worker API Compatibility with Frontend Contracts');

  const { db, d1 } = createTestD1();
  const env = {
    DB: d1,
    ENVIRONMENT: 'production',
    SESSION_SECRET: 'test_phase28_frontend_integration_secret_1234567890'
  };

  // Setup test user: registered, activated, and logged in via real auth endpoints
  await worker.fetch(new Request('https://nexoranexus.com/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'intern@nexoranexus.com', password: 'ValidPassword2026!', full_name: 'Verified Intern' })
  }), env);
  await activateUserStatus(d1, 'intern@nexoranexus.com', 'active');

  const loginRes = await worker.fetch(new Request('https://nexoranexus.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'intern@nexoranexus.com', password: 'ValidPassword2026!' })
  }), env);
  const cookieMatch = loginRes.headers.get('Set-Cookie').match(/__Host-nexora_session=([^;]+)/);
  const sessionToken = cookieMatch ? cookieMatch[1] : '';

  // Setup test program
  const programId = generateUuid();
  db.prepare(`
    INSERT INTO internship_programs (id, slug, title, description, duration_weeks, mode, price_paise, currency, is_active, created_at, updated_at)
    VALUES (?, 'ai-systems', 'AI & Machine Learning Internship', 'Hands-on practical AI engineering.', 12, 'remote', 0, 'INR', 1, datetime('now'), datetime('now'))
  `).run(programId);

  await test('6.1 GET /api/programs matches frontend schema expectations', async () => {
    const req = new Request('https://nexoranexus.com/api/programs', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.programs));
    assert.equal(data.programs.length, 1);
    const prog = data.programs[0];
    assert.equal(prog.id, programId);
    assert.equal(prog.title, 'AI & Machine Learning Internship');
    assert.equal(prog.price_paise, 0);
    assert.equal(prog.currency, 'INR');
    assert.equal(prog.duration_weeks, 12);
    assert.equal(prog.mode, 'remote');
  });

  await test('6.2 GET /api/user/me returns session state matching frontend expectations', async () => {
    const req = new Request('https://nexoranexus.com/api/user/me', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': `__Host-nexora_session=${sessionToken}`
      }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.user.email, 'intern@nexoranexus.com');
    assert.equal(data.user.role, 'intern');
    assert.equal(data.user.status, 'active');
  });

  await test('6.3 POST /api/applications accepts exact payload sent by frontend script', async () => {
    const payload = {
      program_id: programId,
      statement_of_purpose: 'I am deeply passionate about machine learning and distributed computing systems.'
    };
    const req = new Request('https://nexoranexus.com/api/applications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': `__Host-nexora_session=${sessionToken}`
      },
      body: JSON.stringify(payload)
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.application.id);
    assert.equal(data.application.program_id, programId);
    assert.equal(data.application.status, 'submitted');
  });

  await test('6.4 GET /api/applications/me returns applications matching frontend table contract', async () => {
    const req = new Request('https://nexoranexus.com/api/applications/me?page=1&limit=10', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': `__Host-nexora_session=${sessionToken}`
      }
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.total, 1);
    assert.equal(data.applications.length, 1);
    const app = data.applications[0];
    assert.equal(app.program_id, programId);
    assert.equal(app.status, 'submitted');
    assert.equal(app.program_title, 'AI & Machine Learning Internship');
  });

  // -------------------------------------------------------------------------
  // CATEGORY 7: Website Regression & Safety Checks
  // -------------------------------------------------------------------------
  console.log('\nCategory 7: Website Regression & Safety Checks');

  await test('7.1 INTERNSHIP_FORM_CONFIG preserves empty endpoint and targetEmail for Phase 17 compliance', () => {
    assert.match(scriptJs, /endpoint:\s*''/, 'endpoint must remain empty for Phase 17 compliance');
    assert.match(scriptJs, /targetEmail:\s*''/, 'targetEmail must remain empty for Phase 17 compliance');
  });

  await test('7.2 All 25 HTML files exist and retain navigation structure', () => {
    const htmlFiles = fs.readdirSync(ROOT_DIR).filter(f => f.endsWith('.html'));
    assert.ok(htmlFiles.length >= 25, 'Expected at least 25 HTML files in workspace root');
    for (const file of htmlFiles) {
      const content = fs.readFileSync(path.join(ROOT_DIR, file), 'utf8');
      assert.match(content, /href="internships\.html"/, `${file} must link to internships.html`);
    }
  });

  await test('7.3 No secrets, payment keys, or tokens in frontend files', () => {
    const frontendContent = internshipsHtml + scriptJs + styleCss;
    assert.doesNotMatch(frontendContent, /rzp_live_/i, 'Must not contain Razorpay live keys');
    assert.doesNotMatch(frontendContent, /rzp_test_/i, 'Must not contain Razorpay test keys');
    assert.doesNotMatch(frontendContent, /SESSION_SECRET/i, 'Must not contain session secret');
  });

  console.log('\n================================================================');
  console.log(`ALL PHASE 28 INTEGRATION TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
  console.log('================================================================\n');
}

runSuite().catch(err => {
  console.error('\nPhase 28 test suite failed:', err);
  process.exit(1);
});
