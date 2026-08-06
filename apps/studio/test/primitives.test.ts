import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, needsRehash, verifyPassword } from '../src/auth/passwords.ts';
import { RateLimiter } from '../src/http/rate-limit.ts';
import { resolveWithin } from '../src/http/static.ts';
import { buildCsp, inlineScriptHashes, scriptHash } from '../src/http/csp.ts';
import { loadConfig } from '../src/config.ts';
import { validateEvent } from '../src/model/validate-events.ts';

/** Unit tests for the security primitives, independent of any HTTP plumbing. */

describe('password hashing', () => {
  test('a hash verifies its own password and rejects every other', async () => {
    const hash = await hashPassword('a-perfectly-fine-password');
    assert.equal(await verifyPassword('a-perfectly-fine-password', hash), true);
    assert.equal(await verifyPassword('a-perfectly-fine-passwore', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('the same password hashes differently every time', async () => {
    const first = await hashPassword('salted-and-distinct');
    const second = await hashPassword('salted-and-distinct');
    assert.notEqual(first, second, 'a per-hash salt is what stops precomputation');
    assert.equal(await verifyPassword('salted-and-distinct', first), true);
    assert.equal(await verifyPassword('salted-and-distinct', second), true);
  });

  test('the stored form records its own cost parameters', async () => {
    const hash = await hashPassword('parameters-are-embedded');
    const [algorithm, N, r, p] = hash.split('$');
    assert.equal(algorithm, 'scrypt');
    assert.ok(Number(N) >= 1 << 15, 'the work factor must meet current guidance');
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
  });

  test('a malformed or tampered record fails closed instead of throwing', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$1$1$x', 'argon2$1$2$3$4$5', 'scrypt$99999999$8$1$AA$AA']) {
      assert.equal(await verifyPassword('anything', bad), false, `"${bad}" should not verify`);
    }
  });

  test('weaker stored parameters are flagged for upgrade on next sign-in', async () => {
    assert.equal(needsRehash(await hashPassword('current-policy-password')), false);
    assert.equal(needsRehash('scrypt$1024$8$1$AAAA$AAAA'), true);
    assert.equal(needsRehash('nonsense'), true);
  });
});

describe('rate limiting', () => {
  test('a key is allowed exactly its quota inside one window', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, label: 'test' });
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.check('a', now);
    assert.throws(() => limiter.check('a', now), /Too many test requests/);
  });

  test('keys are limited independently', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, label: 'test' });
    limiter.check('a', 0);
    limiter.check('b', 0);
    assert.throws(() => limiter.check('a', 0));
  });

  test('the allowance returns after the window elapses', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, label: 'test' });
    limiter.check('a', 0);
    assert.throws(() => limiter.check('a', 500));
    limiter.check('a', 1001);
  });

  test('clearing a key restores it, so a successful sign-in is not punished', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, label: 'test' });
    limiter.check('a', 0);
    limiter.clear('a');
    limiter.check('a', 0);
  });

  test('the rejection tells the caller when to retry', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, label: 'test' });
    limiter.check('a', 0);
    try {
      limiter.check('a', 0);
      assert.fail('expected a rejection');
    } catch (err) {
      assert.equal((err as { status: number }).status, 429);
      assert.equal((err as { headers: Record<string, string> }).headers['retry-after'], '60');
    }
  });
});

describe('static path containment', () => {
  const root = process.platform === 'win32' ? 'C:\\app\\public' : '/app/public';

  test('an ordinary path resolves inside the root', () => {
    assert.ok(resolveWithin(root, '/app.js')?.endsWith('app.js'));
    assert.ok(resolveWithin(root, '/vendor/three.module.js')?.includes('vendor'));
    assert.ok(resolveWithin(root, '/')?.endsWith('index.html'));
  });

  test('traversal, encoded traversal and null bytes are refused', () => {
    for (const path of [
      '/../server.ts', '/../../etc/passwd', '/%2e%2e/server.ts', '/%2e%2e%2f%2e%2e%2fsecret',
      '/vendor/../../server.ts', '/app.js%00.png', '/%ZZ',
    ]) {
      assert.equal(resolveWithin(root, path), null, `${path} must not resolve`);
    }
  });

  test('a sibling directory sharing the root prefix is refused', () => {
    // The reason containment is checked by path relationship rather than string prefix.
    const sibling = process.platform === 'win32' ? '/../public-backup/secret.txt' : '/../public-backup/secret.txt';
    assert.equal(resolveWithin(root, sibling), null);
  });

  test('dotfiles are refused at any depth', () => {
    assert.equal(resolveWithin(root, '/.env'), null);
    assert.equal(resolveWithin(root, '/.git/config'), null);
    assert.equal(resolveWithin(root, '/vendor/.secret'), null);
  });
});

describe('content security policy', () => {
  test('the baseline policy blocks remote code and framing', () => {
    const csp = buildCsp();
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.includes("'unsafe-inline'") && /script-src[^;]*'unsafe-inline'/.test(csp), false);
  });

  test('an inline script is allowed by the hash of its exact body', () => {
    const html = '<script type="importmap">{"imports":{}}</script><script src="/app.js"></script>';
    const hashes = inlineScriptHashes(html);
    assert.equal(hashes.length, 1, 'only the inline script is hashed');
    assert.equal(hashes[0], scriptHash('{"imports":{}}'));
    assert.match(buildCsp(hashes), /script-src [^;]*'sha256-/);
  });

  test('changing the script body changes the hash', () => {
    assert.notEqual(scriptHash('a'), scriptHash('b'));
  });
});

describe('configuration', () => {
  const base = { BG_SESSION_SECRET: 'x'.repeat(40), HOST: '127.0.0.1' } as NodeJS.ProcessEnv;

  test('defaults bind to loopback with authentication on', () => {
    const config = loadConfig({ ...base, HOST: undefined } as NodeJS.ProcessEnv);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.authMode, 'accounts');
    assert.equal(config.production, false);
  });

  test('production without a session secret refuses to start', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      /BG_SESSION_SECRET is required/,
    );
  });

  test('a short session secret is refused', () => {
    assert.throws(() => loadConfig({ ...base, BG_SESSION_SECRET: 'too-short' }), /at least 32 characters/);
  });

  test('production closes registration by default', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production' });
    assert.equal(config.allowRegistration, false);
  });

  test('unauthenticated mode is confined to loopback and to development', () => {
    assert.throws(() => loadConfig({ ...base, BG_AUTH_MODE: 'open', HOST: '0.0.0.0' }), /loopback/);
    assert.throws(() => loadConfig({ ...base, BG_AUTH_MODE: 'open', NODE_ENV: 'production' }), /not allowed/);
    assert.equal(loadConfig({ ...base, BG_AUTH_MODE: 'open' }).authMode, 'open');
  });

  test('an unparseable limit is a start-up failure, not a silent default', () => {
    assert.throws(() => loadConfig({ ...base, PORT: 'http' }), /positive integer/);
    assert.throws(() => loadConfig({ ...base, BG_BEHIND_TLS_PROXY: 'maybe' }), /boolean/);
  });
});

describe('event validation', () => {
  test('a well-formed event passes through with only its known fields', () => {
    const event = validateEvent({
      type: 'NodeAdded', id: 'n1', kind: 'fixture', x: 1, y: 2, fixtureType: 'Lavatory', extra: 'ignored',
    }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(event).sort(), ['fixtureType', 'id', 'kind', 'type', 'x', 'y']);
  });

  test('identifiers are constrained to characters that are safe in markup and file names', () => {
    assert.throws(() => validateEvent({ type: 'NodeRemoved', id: '<img>' }), /must be 1–64 characters/);
    assert.throws(() => validateEvent({ type: 'NodeRemoved', id: 'a'.repeat(65) }), /must be 1–64 characters/);
    assert.throws(() => validateEvent({ type: 'NodeRemoved', id: '' }), /must be 1–64 characters/);
    assert.ok(validateEvent({ type: 'NodeRemoved', id: 'p_ar_l2x-3.4:5' }));
  });

  test('numeric fields must be finite and in range', () => {
    assert.throws(() => validateEvent({ type: 'NodeMoved', id: 'a', x: Number.NaN, y: 0 }), /finite/);
    assert.throws(() => validateEvent({ type: 'NodeMoved', id: 'a', x: 1e12, y: 0 }), /between/);
    assert.throws(() => validateEvent({ type: 'StackFloorsSet', id: 'a', floors: 2.5 }), /whole number/);
  });

  test('a product carries only the fields the model understands', () => {
    const event = validateEvent({
      type: 'PipeProductSet', id: 'p1',
      product: { name: 'PPR PN20', material: 'PPR-R', odMm: 32, pn: 20, price: 4.2, rogue: 'x' },
    }) as unknown as { product: Record<string, unknown> };
    assert.deepEqual(Object.keys(event.product).sort(), ['material', 'name', 'odMm', 'pn', 'price']);
  });

  test('unbounded collections are capped', () => {
    const waypoints = Array.from({ length: 600 }, (_, i) => ({ x: i, y: i }));
    assert.throws(() => validateEvent({ type: 'PipeReroute', id: 'p', waypoints }), /limited to/);
  });
});
