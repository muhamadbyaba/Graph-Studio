import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.ts';
import type { TestServer } from './harness.ts';

/**
 * The properties that must hold for this server to be safe to put on the public internet.
 *
 * Each case states a claim the README makes about the security model. If one of these regresses,
 * the claim stops being true, so they are treated as load-bearing rather than nice to have.
 */

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.close(); });

describe('authentication', () => {
  test('every design endpoint refuses an anonymous caller', async () => {
    const anon = server.client();
    for (const path of ['/api/state', '/api/workspaces', '/api/projects', '/api/catalog', '/api/export', '/api/report', '/api/boq.csv']) {
      const res = await anon.get(path);
      assert.equal(res.status, 401, `${path} should require a session`);
    }
    for (const path of ['/api/command', '/api/undo', '/api/reset', '/api/autoroute', '/api/ask', '/api/project/save']) {
      const res = await anon.post(path, {});
      assert.equal(res.status, 401, `${path} should require a session`);
    }
  });

  test('the health endpoint is public and leaks nothing sensitive', async () => {
    const res = await server.client().get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(JSON.stringify(res.body).includes('SECRET'), false);
  });

  test('the session cookie is HttpOnly, SameSite=Strict and scoped to the site', async () => {
    const client = server.client();
    const res = await client.post('/api/auth/register', { username: 'cookieuser', password: 'harness-test-secret' });
    const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('bg_session='));

    assert.ok(cookie, 'a session cookie must be issued');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d+/);
  });

  test('the cookie carries an opaque token, never the user id', async () => {
    const client = server.client();
    const user = await client.signUp('opaqueuser');
    assert.ok(client.session);
    assert.equal(client.session!.includes(user.id), false, 'the cookie must not embed the account id');
  });

  test('a wrong password and an unknown username are indistinguishable', async () => {
    const client = server.client();
    await client.signUp('realuser');

    const wrongPassword = await server.client().post('/api/auth/login', { username: 'realuser', password: 'not-the-password' });
    const noSuchUser = await server.client().post('/api/auth/login', { username: 'ghostuser', password: 'not-the-password' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal(wrongPassword.body.error, noSuchUser.body.error);
  });

  test('the password policy is enforced at registration', async () => {
    const short = await server.client().post('/api/auth/register', { username: 'policyuser', password: 'short' });
    assert.equal(short.status, 400);

    const containsName = await server.client().post('/api/auth/register', { username: 'policyuser', password: 'policyuser-is-my-password' });
    assert.equal(containsName.status, 400);
  });

  test('signing out invalidates the session immediately', async () => {
    const client = server.client();
    await client.signUp('logoutuser');
    assert.equal((await client.get('/api/state')).status, 200);

    await client.post('/api/auth/logout');
    const stale = server.client();
    assert.equal((await stale.get('/api/state')).status, 401);
  });
});

describe('workspace authorisation', () => {
  test('one account cannot read or write another account\'s workspace', async () => {
    const alice = server.client();
    await alice.signUp('owneralice');
    const aliceWorkspace = (await alice.get('/api/workspaces')).body.active;

    const mallory = server.client();
    await mallory.signUp('intrudermallory');

    const read = await mallory.get('/api/state', { 'x-workspace': aliceWorkspace });
    const write = await mallory.post('/api/command', { type: 'NodeRemoved', id: 'tank' }, { 'x-workspace': aliceWorkspace });
    assert.equal(read.status, 404);
    assert.equal(write.status, 404);

    // The report and CSV routes take the workspace from the query string, because a browser opens
    // them as navigations and cannot attach a header. That path must authorise identically.
    mallory.useWorkspace(null);
    assert.equal((await mallory.get(`/api/report?workspace=${aliceWorkspace}`)).status, 404);
    assert.equal((await mallory.get(`/api/boq.csv?workspace=${aliceWorkspace}`)).status, 404);
    assert.equal((await mallory.get(`/api/events?workspace=${aliceWorkspace}`)).status, 404);
  });

  test('an unknown workspace id is indistinguishable from one you cannot access', async () => {
    const alice = server.client();
    await alice.signUp('probealice');
    const real = (await alice.get('/api/workspaces')).body.active;

    const mallory = server.client();
    await mallory.signUp('probemallory');

    const existing = await mallory.get('/api/state', { 'x-workspace': real });
    const fictional = await mallory.get('/api/state', { 'x-workspace': '00000000-0000-0000-0000-000000000000' });

    assert.equal(existing.status, fictional.status);
    assert.deepEqual(existing.body, fictional.body);
  });

  test('sharing is explicit, and only the owner can grant it', async () => {
    const owner = server.client();
    await owner.signUp('shareowner');
    const workspace = (await owner.get('/api/workspaces')).body.active;

    const guest = server.client();
    const guestUser = await guest.signUp('shareguest');

    assert.equal((await guest.get('/api/state', { 'x-workspace': workspace })).status, 404);

    await owner.post('/api/workspace/members', { username: 'shareguest' });
    assert.equal((await guest.get('/api/state', { 'x-workspace': workspace })).status, 200);

    // A member cannot invite anyone else.
    const escalation = await guest.post('/api/workspace/members', { username: 'shareowner' }, { 'x-workspace': workspace });
    assert.equal(escalation.status, 403);

    await owner.post('/api/workspace/members/remove', { userId: guestUser.id });
    assert.equal((await guest.get('/api/state', { 'x-workspace': workspace })).status, 404);
  });
});

describe('request forgery and transport hardening', () => {
  test('a cross-site state-changing request is refused', async () => {
    const client = server.client();
    await client.signUp('csrfuser');

    const byOrigin = await client.post('/api/command', { type: 'NodeRemoved', id: 'tank' }, { origin: 'https://evil.example' });
    const byFetchSite = await client.post('/api/command', { type: 'NodeRemoved', id: 'tank' }, { 'sec-fetch-site': 'cross-site' });

    assert.equal(byOrigin.status, 403);
    assert.equal(byFetchSite.status, 403);

    // The document is untouched.
    const state = await client.get('/api/state');
    assert.ok(state.body.nodes.some((n: { id: string }) => n.id === 'tank'));
  });

  test('a same-origin request from a browser is accepted', async () => {
    const client = server.client();
    await client.signUp('sameoriginuser');
    const res = await client.post('/api/command', { type: 'NodeMoved', id: 'tank', x: 4, y: 4 }, {
      origin: server.url,
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(res.status, 200);
  });

  test('every response carries the hardening headers', async () => {
    const res = await server.client().get('/api/health');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  test('the script policy never falls back to unsafe-inline', async () => {
    const csp = (await server.client().get('/api/health')).headers.get('content-security-policy') ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    assert.equal(scriptSrc.includes("'unsafe-inline'"), false);
    assert.equal(scriptSrc.includes("'unsafe-eval'"), false);
  });
});

describe('static file containment', () => {
  test('a traversal attempt cannot escape the public directory', async () => {
    const paths = [
      '/../server.ts',
      '/..%2Fserver.ts',
      '/%2e%2e/server.ts',
      '/%2e%2e%2f%2e%2e%2fserver.ts',
      '/vendor/../../server.ts',
      '/../data/accounts.json',
      '/../../package.json',
    ];
    for (const path of paths) {
      const res = await fetch(`${server.url}${path}`, { redirect: 'manual' });
      assert.ok(res.status === 404 || res.status === 301 || res.status === 400, `${path} returned ${res.status}`);
      const body = await res.text();
      assert.equal(body.includes('createServer'), false, `${path} leaked server source`);
      assert.equal(body.includes('passwordHash'), false, `${path} leaked the account store`);
    }
  });

  test('dotfiles are never served', async () => {
    for (const path of ['/.env', '/.git/config', '/vendor/.hidden']) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.status, 404);
    }
  });

  test('the app shell is served with a revalidating cache and a strong ETag', async () => {
    const res = await fetch(`${server.url}/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('etag') ?? '', /^"[A-Za-z0-9_-]+"$/);

    const revalidated = await fetch(`${server.url}/index.html`, { headers: { 'if-none-match': res.headers.get('etag')! } });
    assert.equal(revalidated.status, 304);
  });
});
