import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.ts';
import type { TestServer } from './harness.ts';
import { csvCell } from '../src/report/csv.ts';

/**
 * The documents an engineer actually hands over: the design report and the priced Bill of
 * Quantities. Both leave the system and are opened elsewhere, so both are treated as untrusted
 * output sinks — the report by a browser, the CSV by a spreadsheet.
 */

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.close(); });

/** A design with every discipline present, so the report renders all of its sections. */
const FULL_DESIGN = [
  { type: 'NodeAdded', id: 'sew', kind: 'outlet', x: 3, y: 12 },
  { type: 'NodeAdded', id: 'vt', kind: 'vent-terminal', x: 5, y: 13 },
  { type: 'NodeAdded', id: 'sh', kind: 'fixture', x: 15, y: 9, fixtureType: 'Shower' },
  { type: 'NodeAdded', id: 'db', kind: 'panel', x: 1, y: 2 },
  { type: 'NodeAdded', id: 'ld', kind: 'load', x: 12, y: 2 },
  { type: 'NodeAdded', id: 'ahu', kind: 'ahu', x: 2, y: 14 },
  { type: 'NodeAdded', id: 'dif', kind: 'diffuser', x: 16, y: 13 },
  { type: 'NodeAdded', id: 'c1', kind: 'support', x: 20, y: 3 },
  { type: 'NodeAdded', id: 'c2', kind: 'support', x: 20, y: 11 },
  { type: 'PipeAdded', id: 'p_sh', from: 'tank', to: 'sh', medium: 'cold' },
  { type: 'PipeAdded', id: 'd_sh', from: 'sew', to: 'sh', medium: 'drainage' },
  { type: 'PipeAdded', id: 'v_sh', from: 'vt', to: 'sh', medium: 'vent' },
  { type: 'PipeAdded', id: 'e_ld', from: 'db', to: 'ld', medium: 'power' },
  { type: 'PipeAdded', id: 'a_df', from: 'ahu', to: 'dif', medium: 'air' },
  { type: 'PipeAdded', id: 'bm', from: 'c1', to: 'c2', medium: 'beam' },
];

async function designedClient(username: string) {
  const client = server.client();
  await client.signUp(username);
  await client.post('/api/command', FULL_DESIGN);
  return client;
}

describe('design report', () => {
  test('renders every discipline section from the model', async () => {
    const client = await designedClient('reportuser');
    const res = await client.get<string>('/api/report');

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);

    for (const heading of [
      'Cost summary by discipline', 'Code compliance register', 'Plumbing — supply',
      'pressure balance', 'drainage (gravity)', 'Plumbing — vent', 'Electrical — cables',
      'HVAC — ducts', 'Structural', 'Bill of Quantities', 'not for construction',
    ]) {
      assert.ok(res.body.includes(heading), `the report should contain "${heading}"`);
    }
  });

  test('contains no placeholder artefacts from unset values', async () => {
    const client = await designedClient('reportcleanuser');
    const body = (await client.get<string>('/api/report')).body;
    const content = body.slice(body.indexOf('<body>'));

    assert.equal(content.includes('undefined'), false, 'an unset value leaked as "undefined"');
    assert.equal(content.includes('NaN'), false, 'a computation produced NaN');
    assert.equal(content.includes('[object Object]'), false);
  });

  test('escapes project metadata rather than rendering it as markup', async () => {
    const client = await designedClient('reportxssuser');
    await client.post('/api/project-meta', {
      title: '<script>alert(1)</script> Tower',
      client: 'Acme "Big" Co',
      engineer: 'A & B Partners',
      projectNo: "O'Brien 2026",
      revision: 'A',
    });

    const body = (await client.get<string>('/api/report')).body;
    assert.equal(body.includes('<script>alert(1)</script>'), false, 'markup must not survive into the report');
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(body.includes('Acme &quot;Big&quot; Co'));
    assert.ok(body.includes('A &amp; B Partners'));
  });

  test('carries a policy that permits only its own print script', async () => {
    const client = await designedClient('reportcspuser');
    const res = await client.get<string>('/api/report');
    const csp = res.headers.get('content-security-policy') ?? '';

    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? '';
    assert.match(scriptSrc, /'sha256-[A-Za-z0-9+/=]+'/, 'the print script must be allowed by hash');
    assert.equal(scriptSrc.includes("'unsafe-inline'"), false);
    assert.equal(res.body.includes('onclick='), false, 'an inline event handler would force unsafe-inline');
  });
});

describe('bill of quantities export', () => {
  test('is a downloadable CSV with a total', async () => {
    const client = await designedClient('csvuser');
    const res = await client.get<string>('/api/boq.csv');

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename=/);

    const lines = res.body.split('\r\n');
    assert.match(lines[0], /^﻿?Discipline,Item Code,Description,Qty,Unit,Rate,Amount$/);
    assert.ok(lines.some((l) => l.includes('Project Total')));
    assert.ok(lines.length > 4);
  });

  test('neutralises spreadsheet formula injection in exported text', async () => {
    const client = await designedClient('csvinjectionuser');
    await client.post('/api/command', {
      type: 'PipeProductSet',
      id: 'p_sh',
      product: { name: '=HYPERLINK("http://evil.example")', material: 'PPR', odMm: 25, price: 9.9 },
    });

    const csv = (await client.get<string>('/api/boq.csv')).body;
    const row = csv.split('\r\n').find((l) => l.includes('HYPERLINK'));

    assert.ok(row, 'the product should appear in the export');
    const description = row.split(',')[2];
    assert.equal(description.startsWith('='), false, 'a leading = would be evaluated by a spreadsheet');
  });

  test('csvCell quotes separators and defuses every formula lead character', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('has, comma'), '"has, comma"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('line\r\nbreak'), '"line\r\nbreak"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(42), '42');

    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const cell = csvCell(`${lead}cmd`);
      assert.equal(cell.replace(/^"/, '').startsWith("'"), true, `${JSON.stringify(lead)} should be escaped`);
    }
  });
});

describe('live collaboration', () => {
  test('an edit by one member is pushed to the other', async () => {
    const owner = server.client();
    await owner.signUp('collabowner');
    const workspace = (await owner.get('/api/workspaces')).body.active;

    const guest = server.client();
    await guest.signUp('collabguest');
    await owner.post('/api/workspace/members', { username: 'collabguest' });

    const stream = await fetch(`${server.url}/api/events?workspace=${workspace}&client=guest-tab`, {
      headers: { cookie: guest.session! },
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();

    const readUntil = async (predicate: (buffer: string) => boolean, timeoutMs = 5000): Promise<string> => {
      let buffer = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (predicate(buffer)) return buffer;
      }
      throw new Error(`stream did not deliver the expected frame; saw: ${buffer.slice(0, 200)}`);
    };

    await readUntil((b) => b.includes('event: ready'));

    await owner.post('/api/command', { type: 'NodeAdded', id: 'collab_node', kind: 'junction', x: 7, y: 7 },
      { 'x-client-id': 'owner-tab' });

    const frame = await readUntil((b) => b.includes('collab_node'));
    assert.match(frame, /"origin":"owner-tab"/);

    await reader.cancel();
  });

  test('a stream cannot be opened on a workspace you do not belong to', async () => {
    const owner = server.client();
    await owner.signUp('streamowner');
    const workspace = (await owner.get('/api/workspaces')).body.active;

    const outsider = server.client();
    await outsider.signUp('streamoutsider');
    outsider.useWorkspace(null);

    const res = await outsider.get(`/api/events?workspace=${workspace}`);
    assert.equal(res.status, 404);
  });
});
