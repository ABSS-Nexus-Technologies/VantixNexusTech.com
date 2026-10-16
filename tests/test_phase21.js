/**
 * Nexora Nexus — Phase 21 Test Suite
 *
 * Verifies:
 * 1. Worker API routing, health endpoint, JSON envelopes, security headers.
 * 2. Same-origin CORS enforcement & method restrictions.
 * 3. Static asset passthrough via env.ASSETS.fetch().
 * 4. D1 schema execution, table creation, indexes, and idempotency.
 * 5. Foreign keys, uniqueness, and check constraints (integer paise, merit-gated certs).
 * 6. Hardcoded secret detection across backend files.
 * 7. Existing static site integrity across all 25 HTML pages.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';

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

console.log('\n======================================================');
console.log('--- SUITE 1: CLOUDFLARE WORKER ROUTER & SECURITY ---');
console.log('======================================================');

await runAsyncTest('Worker: GET /api/health returns 200 with JSON health status and security headers', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/health', {
    method: 'GET'
  });
  const res = await worker.fetch(req, { ENVIRONMENT: 'production' });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(res.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.equal(res.headers.get('Cache-Control'), 'no-store, no-cache, must-revalidate, proxy-revalidate');

  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'nexora-nexus-api');
  assert.equal(data.environment, 'production');
  assert.ok(data.timestamp);
});

await runAsyncTest('Worker: POST /api/health returns 405 Method Not Allowed with Allow header', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/health', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET, OPTIONS');
  const data = await res.json();
  assert.equal(data.error.code, 'METHOD_NOT_ALLOWED');
});

await runAsyncTest('Worker: GET /api returns operational index', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api', {
    method: 'GET'
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.service, 'nexora-nexus-api');
  assert.equal(data.status, 'operational');
});

await runAsyncTest('Worker: Unknown /api/* route returns standardized JSON 404', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/non-existent-endpoint', {
    method: 'GET'
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const data = await res.json();
  assert.equal(data.error.code, 'NOT_FOUND');
  assert.equal(data.error.message, 'API endpoint not found');
});

await runAsyncTest('Worker: Cross-origin request from untrusted origin is rejected with 403 (No wildcard CORS)', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/health', {
    method: 'GET',
    headers: { 'Origin': 'https://malicious-external-site.com' }
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null); // Must NEVER allow wildcard or untrusted origin
  const data = await res.json();
  assert.equal(data.error.code, 'CORS_FORBIDDEN');
});

await runAsyncTest('Worker: OPTIONS preflight from same origin returns 204 with same-origin header', async () => {
  const origin = 'https://vantixnexustech-com.abssnexus.workers.dev';
  const req = new Request(`${origin}/api/health`, {
    method: 'OPTIONS',
    headers: { 'Origin': origin }
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin);
  assert.notEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
});

await runAsyncTest('Worker: Mutating request without application/json Content-Type is rejected with 415', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/unknown-action', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'plain-text-body'
  });
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 415);
  const data = await res.json();
  assert.equal(data.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

await runAsyncTest('Worker: Static website route delegates to env.ASSETS.fetch()', async () => {
  let assetsFetchCalled = false;
  let requestedUrl = '';

  const mockEnv = {
    ASSETS: {
      fetch: async (request) => {
        assetsFetchCalled = true;
        requestedUrl = request.url;
        return new Response('<!DOCTYPE html><html><body>Home</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }
  };

  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/internships.html', {
    method: 'GET'
  });
  const res = await worker.fetch(req, mockEnv);

  assert.ok(assetsFetchCalled, 'env.ASSETS.fetch should have been invoked for static route');
  assert.equal(requestedUrl, 'https://vantixnexustech-com.abssnexus.workers.dev/internships.html');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Home'));
});

await runAsyncTest('Worker: Unhandled internal error returns safe 500 without leaking stack trace', async () => {
  const req = new Request('https://vantixnexustech-com.abssnexus.workers.dev/api/health', {
    method: 'GET'
  });
  // Simulate an env that throws unexpectedly during execution
  const throwingEnv = {
    get ENVIRONMENT() {
      throw new Error('Database connection failed: secret_db_key_12345');
    }
  };

  const res = await worker.fetch(req, throwingEnv);
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error.code, 'INTERNAL_ERROR');
  assert.equal(data.error.message, 'An unexpected internal server error occurred');
  // Confirm sensitive error message was NOT leaked
  assert.equal(JSON.stringify(data).includes('secret_db_key_12345'), false);
});

console.log('\n======================================================');
console.log('--- SUITE 2: D1 DATABASE SCHEMA & CONSTRAINTS ---');
console.log('======================================================');

const migrationSql = fs.readFileSync(path.join(ROOT_DIR, 'migrations/0001_initial_schema.sql'), 'utf8');

runTest('D1 Migration: Applies cleanly to in-memory SQLite database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").all();
  const tableNames = tables.map(t => t.name);

  const requiredTables = [
    'users',
    'user_sessions',
    'intern_profiles',
    'internship_programs',
    'applications',
    'payment_orders',
    'payment_records',
    'tasks',
    'submissions',
    'reviews',
    'completion_approvals',
    'certificates',
    'audit_events'
  ];

  for (const table of requiredTables) {
    assert.ok(tableNames.includes(table), `Table ${table} must exist`);
  }
  db.close();
});

runTest('D1 Migration: Idempotency check (can run migration repeatedly without error)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);
  // Re-run migration
  db.exec(migrationSql);
  db.close();
});

runTest('D1 Constraints: Foreign key enforcement works', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);

  // Attempting to insert an intern profile for a non-existent user must fail
  assert.throws(() => {
    db.prepare(`
      INSERT INTO intern_profiles (id, user_id, full_name)
      VALUES ('prof_1', 'non_existent_user', 'John Doe')
    `).run();
  }, /FOREIGN KEY constraint failed/);

  db.close();
});

runTest('D1 Constraints: User email uniqueness and case insensitivity', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);

  db.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, role)
    VALUES ('u1', 'intern@nexoranexus.com', 'hash1', 'salt1', 'intern')
  `).run();

  // Duplicate email with different casing must fail
  assert.throws(() => {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt, role)
      VALUES ('u2', 'INTERN@NEXORANEXUS.COM', 'hash2', 'salt2', 'intern')
    `).run();
  }, /UNIQUE constraint failed/);

  db.close();
});

runTest('D1 Constraints: Program pricing must be integer paise >= 0', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);

  // Negative price must fail CHECK constraint
  assert.throws(() => {
    db.prepare(`
      INSERT INTO internship_programs (id, slug, title, description, duration_weeks, price_paise)
      VALUES ('p1', 'test-slug', 'Test Program', 'Desc', 4, -100)
    `).run();
  }, /CHECK constraint failed/);

  // Valid price in integer paise (e.g. ₹4,999 = 499900 paise) succeeds
  db.prepare(`
    INSERT INTO internship_programs (id, slug, title, description, duration_weeks, price_paise)
    VALUES ('p1', 'test-slug', 'Test Program', 'Desc', 4, 499900)
  `).run();

  const prog = db.prepare('SELECT price_paise, currency FROM internship_programs WHERE id = ?').get('p1');
  assert.equal(prog.price_paise, 499900);
  assert.equal(prog.currency, 'INR');

  db.close();
});

runTest('D1 Constraints: Certificate strictly requires valid completion_approval', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrationSql);

  // Create user & program
  db.prepare(`INSERT INTO users (id, email, password_hash, password_salt, role) VALUES ('u1', 'u@test.com', 'h', 's', 'intern')`).run();
  db.prepare(`INSERT INTO internship_programs (id, slug, title, description, duration_weeks, price_paise) VALUES ('p1', 'slug', 'Title', 'Desc', 4, 499900)`).run();
  db.prepare(`INSERT INTO applications (id, user_id, program_id, status) VALUES ('app1', 'u1', 'p1', 'submitted')`).run();

  // Attempting to create certificate without completion approval must fail FK
  assert.throws(() => {
    db.prepare(`
      INSERT INTO certificates (
        id, certificate_code, application_id, user_id, program_id,
        completion_approval_id, recipient_name, program_title, issue_date, pdf_r2_key
      ) VALUES (
        'cert1', 'NEX-2026-0001', 'app1', 'u1', 'p1',
        'non_existent_approval', 'Candidate', 'Web Dev', '2026-10-13', 'certs/cert1.pdf'
      )
    `).run();
  }, /FOREIGN KEY constraint failed/);

  // Now create valid completion approval with all_tasks_verified = 1
  db.prepare(`INSERT INTO users (id, email, password_hash, password_salt, role) VALUES ('admin1', 'admin@test.com', 'h', 's', 'admin')`).run();
  db.prepare(`
    INSERT INTO completion_approvals (id, application_id, approved_by, approval_notes, all_tasks_verified)
    VALUES ('appr1', 'app1', 'admin1', 'All tasks approved', 1)
  `).run();

  // Certificate insertion now succeeds
  db.prepare(`
    INSERT INTO certificates (
      id, certificate_code, application_id, user_id, program_id,
      completion_approval_id, recipient_name, program_title, issue_date, pdf_r2_key
    ) VALUES (
      'cert1', 'NEX-2026-0001', 'app1', 'u1', 'p1',
      'appr1', 'Candidate', 'Web Dev', '2026-10-13', 'certs/cert1.pdf'
    )
  `).run();

  const cert = db.prepare('SELECT certificate_code, is_revoked FROM certificates WHERE id = ?').get('cert1');
  assert.equal(cert.certificate_code, 'NEX-2026-0001');
  assert.equal(cert.is_revoked, 0);

  db.close();
});

console.log('\n======================================================');
console.log('--- SUITE 3: ASSET & SECRET HYGIENE AUDIT ---');
console.log('======================================================');

runTest('.assetsignore: Protects worker/, migrations/, and tests/ from static bundle', () => {
  const assetsIgnore = fs.readFileSync(path.join(ROOT_DIR, '.assetsignore'), 'utf8');
  assert.ok(assetsIgnore.includes('worker/'), '.assetsignore must include worker/');
  assert.ok(assetsIgnore.includes('migrations/'), '.assetsignore must include migrations/');
  assert.ok(assetsIgnore.includes('tests/'), '.assetsignore must include tests/');
});

runTest('wrangler.toml: Configures main = "worker/index.js" and preserves assets', () => {
  const wranglerToml = fs.readFileSync(path.join(ROOT_DIR, 'wrangler.toml'), 'utf8');
  assert.ok(wranglerToml.includes('main = "worker/index.js"'), 'wrangler.toml must configure main');
  assert.ok(wranglerToml.includes('[assets]'), 'wrangler.toml must retain [assets]');
  assert.ok(wranglerToml.includes('not_found_handling = "404-page"'), 'wrangler.toml must retain not_found_handling');
  assert.ok(wranglerToml.includes('html_handling = "auto-trailing-slash"'), 'wrangler.toml must retain html_handling');
  // Verify NO fake D1 database_id was uncommented or invented
  assert.ok(!wranglerToml.match(/^\s*database_id\s*=\s*["'][^"']+["']/m), 'No active D1 database_id should be configured until provisioned');
});

runTest('Zero Secrets: No live or test Razorpay / API keys hardcoded', () => {
  const filesToCheck = [
    'worker/index.js',
    'wrangler.toml',
    'migrations/0001_initial_schema.sql',
    'SECURITY_FOUNDATION.md'
  ];

  const forbiddenPatterns = [
    /rzp_live_[a-zA-Z0-9]{14,}/,
    /rzp_test_[a-zA-Z0-9]{14,}/,
    /AKIA[0-9A-Z]{16}/,
    /eyJ[a-zA-Z0-9-_]+\.[a-zA-Z0-9-_]+\.[a-zA-Z0-9-_]+/ // JWT
  ];

  for (const relPath of filesToCheck) {
    const content = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert.ok(!pattern.test(content), `File ${relPath} contains prohibited credential pattern ${pattern}`);
    }
  }
});

console.log('\n======================================================');
console.log('--- SUITE 4: EXISTING WEBSITE PAGES INTEGRITY ---');
console.log('======================================================');

runTest('Static Pages: All 25 HTML pages exist and retain structural integrity', () => {
  const expectedPages = [
    'index.html',
    'about.html',
    'services.html',
    'work.html',
    'contact.html',
    'solutions.html',
    'internships.html',
    'privacy.html',
    'terms.html',
    '404.html',
    'website-development.html',
    'software-development.html',
    'mobile-app-development.html',
    'ecommerce-development.html',
    'ui-ux-design.html',
    'cloud-computing.html',
    'cybersecurity.html',
    'ai-machine-learning.html',
    'data-analytics-bi.html',
    'devops-automation.html',
    'it-consulting-digital-transformation.html',
    'software-testing-qa.html',
    'digital-marketing-seo.html',
    'saas-development.html',
    'api-development-integration.html'
  ];

  for (const page of expectedPages) {
    const filePath = path.join(ROOT_DIR, page);
    assert.ok(fs.existsSync(filePath), `Page ${page} must exist`);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.length > 5000, `Page ${page} must have content`);
    assert.ok(content.includes('<!DOCTYPE html>'), `Page ${page} must have DOCTYPE`);
    assert.ok(content.includes('style.css'), `Page ${page} must link to style.css`);
    assert.ok(content.includes('script.js'), `Page ${page} must link to script.js`);
  }
});

console.log('\n======================================================');
console.log(`ALL TESTS PASSED: ${passedTests}/${totalTests} tests successful.`);
console.log('======================================================\n');
