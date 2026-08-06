import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLE_EDITS, startTestServer } from './harness.ts';
import type { TestServer } from './harness.ts';

/**
 * The design API: what it accepts, what it refuses, and what it never lets a client corrupt.
 *
 * The recurring theme is that a rejected edit must leave the document exactly as it was. Event
 * sourcing makes a half-applied batch particularly costly — the bad event would replay on every
 * subsequent open — so atomicity is checked explicitly rather than assumed.
 */

let server: TestServer;
before(async () => { server = await startTestServer(); });
after(async () => { await server.close(); });

describe('editing the model', () => {
  test('a valid batch applies and the engine recomputes the whole design', async () => {
    const client = server.client();
    await client.signUp('editoruser');

    const before = await client.get('/api/state');
    assert.equal(before.body.pipes.length, 1);

    const res = await client.post('/api/command', SAMPLE_EDITS);
    assert.equal(res.status, 200);
    assert.equal(res.body.pipes.length, 2);

    // Sizing, hydraulics and the priced bill of quantities all follow from the same edit.
    const seed = res.body.pipes.find((p: { id: string }) => p.id === 'p_seed');
    assert.equal(typeof seed.sizeOd, 'number');
    assert.equal(seed.sizePass, true);
    assert.ok(res.body.costTotal > 0);
    assert.equal(res.body.pressure.hasSource, true);
    assert.ok(res.body.boq.length >= 2);
  });

  test('an incoherent edit is refused with an explanation, not a 500', async () => {
    const client = server.client();
    await client.signUp('coherenceuser');

    const cases: Array<[string, unknown, RegExp]> = [
      ['a pipe to a node that does not exist', { type: 'PipeAdded', id: 'x', from: 'tank', to: 'ghost', medium: 'cold' }, /unknown node/],
      ['a duplicate id', { type: 'NodeAdded', id: 'tank', kind: 'junction', x: 1, y: 1 }, /already exists/],
      ['a pipe joining a node to itself', { type: 'PipeAdded', id: 'x', from: 'tank', to: 'tank', medium: 'cold' }, /itself/],
      ['a slope on a pressurised pipe', { type: 'PipeSlopeChanged', id: 'p_seed', slopePct: 2 }, /not a drainage pipe/],
      ['moving a node that is not there', { type: 'NodeMoved', id: 'nope', x: 1, y: 1 }, /unknown node/],
    ];

    for (const [name, event, message] of cases) {
      const res = await client.post('/api/command', event);
      assert.equal(res.status, 400, `${name} should be a client error`);
      assert.match(res.body.error, message, name);
    }
  });

  test('malformed input is rejected before it reaches the model', async () => {
    const client = server.client();
    await client.signUp('validationuser');

    const cases: Array<[string, unknown]> = [
      ['markup in a fixture type', { type: 'NodeAdded', id: 'a', kind: 'fixture', x: 1, y: 1, fixtureType: '<script>alert(1)</script>' }],
      ['markup in an id', { type: 'NodeAdded', id: '<img src=x onerror=1>', kind: 'junction', x: 1, y: 1 }],
      ['a non-finite coordinate', { type: 'NodeAdded', id: 'b', kind: 'junction', x: null, y: 1 }],
      ['a coordinate beyond the plan', { type: 'NodeAdded', id: 'c', kind: 'junction', x: 1e30, y: 1 }],
      ['an unknown node kind', { type: 'NodeAdded', id: 'd', kind: 'wormhole', x: 1, y: 1 }],
      ['an unknown medium', { type: 'PipeAdded', id: 'e', from: 'tank', to: 'wc', medium: 'plasma' }],
      ['an unknown event type', { type: 'DropEverything', id: 'f' }],
      ['a slab with too few corners', { type: 'SlabAdded', id: 'g', corners: ['tank'] }],
    ];

    for (const [name, event] of cases) {
      const res = await client.post('/api/command', event);
      assert.equal(res.status, 400, `${name} should be rejected`);
    }
  });

  test('a batch is all-or-nothing', async () => {
    const client = server.client();
    await client.signUp('atomicuser');
    const before = (await client.get('/api/state')).body.nodes.length;

    const res = await client.post('/api/command', [
      { type: 'NodeAdded', id: 'good', kind: 'junction', x: 5, y: 5 },
      { type: 'PipeAdded', id: 'bad', from: 'good', to: 'missing', medium: 'cold' },
    ]);

    assert.equal(res.status, 400);
    const after = await client.get('/api/state');
    assert.equal(after.body.nodes.length, before, 'the valid half of the batch must be discarded too');
    assert.equal(after.body.nodes.some((n: { id: string }) => n.id === 'good'), false);
  });

  test('a rejected edit leaves the document readable', async () => {
    const client = server.client();
    await client.signUp('resilientuser');
    await client.post('/api/command', SAMPLE_EDITS);

    await client.post('/api/command', { type: 'PipeAdded', id: 'poison', from: 'tank', to: 'nowhere', medium: 'cold' });

    const state = await client.get('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.pipes.length, 2);
  });

  test('prototype-polluting keys are stripped from the request body', async () => {
    const client = server.client();
    await client.signUp('pollutionuser');

    const res = await client.request('POST', '/api/command', undefined, { 'content-type': 'application/json' });
    void res;

    await fetch(`${server.url}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: client.session! },
      body: '{"type":"NodeAdded","id":"pp","kind":"junction","x":1,"y":1,"__proto__":{"polluted":true}}',
    });

    assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype must be untouched');
  });

  test('undo and redo move along the event log', async () => {
    const client = server.client();
    await client.signUp('historyuser');
    await client.post('/api/command', SAMPLE_EDITS);

    const undone = await client.post('/api/undo');
    assert.equal(undone.body.pipes.length, 1);
    assert.equal(undone.body.canRedo, true);

    const redone = await client.post('/api/redo');
    assert.equal(redone.body.pipes.length, 2);
  });
});

describe('jurisdictions', () => {
  test('switching the code pack re-validates the same design', async () => {
    const client = server.client();
    await client.signUp('jurisdictionuser');

    // A 20 m circuit: the cable size depends on the nominal voltage, which the pack supplies.
    await client.post('/api/command', [
      { type: 'NodeAdded', id: 'db', kind: 'panel', x: 1, y: 1 },
      { type: 'NodeAdded', id: 'load1', kind: 'load', x: 21, y: 1 },
      { type: 'PipeAdded', id: 'c1', from: 'db', to: 'load1', medium: 'power' },
    ]);

    const gulf = (await client.get('/api/state')).body.pipes.find((p: { id: string }) => p.id === 'c1');
    const us = (await client.post('/api/jurisdiction', { id: 'US' })).body.pipes.find((p: { id: string }) => p.id === 'c1');

    assert.match((await client.get('/api/state')).body.jurisdiction, /^US@/);
    assert.ok(us.sizeOd >= gulf.sizeOd, 'a lower nominal voltage cannot need a smaller conductor');

    const back = await client.post('/api/jurisdiction', { id: 'GULF' });
    assert.equal(back.body.pipes.find((p: { id: string }) => p.id === 'c1').sizeOd, gulf.sizeOd,
      'switching back must reproduce the original result exactly');
  });

  test('an unknown jurisdiction is rejected', async () => {
    const client = server.client();
    await client.signUp('badjurisdiction');
    const res = await client.post('/api/jurisdiction', { id: 'ATLANTIS' });
    assert.equal(res.status, 400);
  });
});

describe('assisted design', () => {
  test('auto-routing connects fixtures and reports what it did', async () => {
    const client = server.client();
    await client.signUp('routinguser');
    await client.post('/api/command', [
      { type: 'NodeAdded', id: 'f1', kind: 'fixture', x: 14, y: 3, fixtureType: 'Lavatory' },
      { type: 'NodeAdded', id: 'f2', kind: 'fixture', x: 18, y: 9, fixtureType: 'Shower' },
    ]);

    const routed = await client.post('/api/autoroute', { medium: 'cold' });
    assert.equal(routed.status, 200);
    assert.ok(routed.body.applied > 0);
    assert.match(routed.body.notice, /Routed \d+ new cold run/);

    // Running it again is a no-op, not an error.
    const again = await client.post('/api/autoroute', { medium: 'cold' });
    assert.equal(again.status, 200);
    assert.equal(again.body.applied, 0);
  });

  test('auto-routing explains what is missing rather than failing silently', async () => {
    const client = server.client();
    await client.signUp('routinghintuser');
    const res = await client.post('/api/autoroute', { medium: 'drainage' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /sewer outlet/);
  });

  test('the assistant answers from the engine when no model is configured', async () => {
    const client = server.client();
    await client.signUp('assistantuser');
    const res = await client.post('/api/ask', { question: 'what is the total cost?' });

    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'grounded');
    assert.match(res.body.answer, /\$/);
  });
});

describe('projects', () => {
  test('a project round-trips through save, reset and reopen', async () => {
    const client = server.client();
    await client.signUp('projectuser');
    await client.post('/api/command', SAMPLE_EDITS);

    const saved = await client.post('/api/project/save', { name: 'Villa A / Level 1' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.name, 'Villa A / Level 1');

    await client.post('/api/reset');
    assert.equal((await client.get('/api/state')).body.pipes.length, 1);

    const reopened = await client.post('/api/project/load', { name: 'Villa A / Level 1' });
    assert.equal(reopened.body.pipes.length, 2);

    const list = await client.get('/api/projects');
    assert.equal(list.body.projects.length, 1);

    await client.post('/api/project/delete', { name: 'Villa A / Level 1' });
    assert.equal((await client.get('/api/projects')).body.projects.length, 0);
  });

  test('a project name that looks like a path cannot escape its workspace folder', async () => {
    const client = server.client();
    await client.signUp('pathuser');
    // Accepted as a *name* — the file it maps to is a hash, so the characters carry no meaning.
    const saved = await client.post('/api/project/save', { name: '../../../etc/passwd' });
    assert.equal(saved.status, 200);

    const list = await client.get('/api/projects');
    assert.equal(list.body.projects.length, 1);
    assert.equal(list.body.projects[0].name, '../../../etc/passwd');
  });

  test('one workspace cannot see another workspace\'s projects', async () => {
    const alice = server.client();
    await alice.signUp('projalice');
    await alice.post('/api/project/save', { name: 'Alice Tower' });

    const bob = server.client();
    await bob.signUp('projbob');
    assert.equal((await bob.get('/api/projects')).body.projects.length, 0);
    assert.equal((await bob.post('/api/project/load', { name: 'Alice Tower' })).status, 404);
  });
});

describe('component library', () => {
  test('custom components are scoped to the workspace that created them', async () => {
    const alice = server.client();
    await alice.signUp('libalice');
    const added = await alice.post('/api/catalog', {
      discipline: 'plumbing', category: 'pipe', name: 'Alice Special PPR', spec: { odMm: 25 }, unit: 'm', price: 9.5,
    });
    assert.equal(added.status, 201);

    const mine = await alice.get('/api/catalog?q=Alice Special');
    assert.equal(mine.body.items.length, 1);

    const bob = server.client();
    await bob.signUp('libbob');
    assert.equal((await bob.get('/api/catalog?q=Alice Special')).body.items.length, 0);
  });

  test('a component with a missing required field is rejected', async () => {
    const client = server.client();
    await client.signUp('libvalidation');
    assert.equal((await client.post('/api/catalog', { discipline: 'plumbing' })).status, 400);
  });
});
