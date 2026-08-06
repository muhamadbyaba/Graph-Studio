import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlumbingLayout } from '../src/model/layout.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';
import { approx } from './helpers.ts';

/** outlet(0,0) — drain — junction(5,0) — {WC(5,2), Lav(7,0)} ; plus a supply source feeding the WC */
function mixed(): PlumbingLayout {
  return new PlumbingLayout(GULF_V1)
    .addNode('sewer', 'outlet', 0, 0)
    .addNode('j', 'junction', 5, 0)
    .addNode('wc', 'fixture', 5, 2, 'WaterCloset')
    .addNode('lav', 'fixture', 7, 0, 'Lavatory')
    .addPipe('dmain', 'sewer', 'j', 'drainage')
    .addPipe('dwc', 'j', 'wc', 'drainage')
    .addPipe('dlav', 'j', 'lav', 'drainage')
    // supply side sharing the same fixtures
    .addNode('tank', 'source', 0, 8)
    .addPipe('smain', 'tank', 'wc', 'cold');
}

test('drainage main carries cumulative DFU of its downstream fixtures', () => {
  const net = mixed();
  approx(net.pipes.get('dmain')!.cumulativeDfu.get(), 5, 1e-9); // WC 4 + Lav 1
  approx(net.pipes.get('dwc')!.cumulativeDfu.get(), 4, 1e-9);
});

test('drainage pipe is sized from DFU (Ø75 for 5 DFU)', () => {
  const net = mixed();
  assert.equal(net.pipes.get('dmain')!.sizing.get().value, 75);
});

test('default slope passes; under-grading a small drain fails the slope check', () => {
  const net = mixed();
  const dlav = net.pipes.get('dlav')!; // Lav only → 1 DFU → Ø40 (min slope 2%)
  assert.equal(dlav.sizing.get().value, 40);
  assert.equal(dlav.slopeCheck!.get().pass, true); // default 2% ≥ 2%
  net.setPipeSlope('dlav', 1); // below the 2% minimum for a 40 mm drain
  assert.equal(dlav.slopeCheck!.get().pass, false);
});

test('supply and drainage are independent systems on the shared fixtures', () => {
  const net = mixed();
  // the supply main to the WC uses WSFU (not DFU); drainage uses DFU
  approx(net.pipes.get('smain')!.cumulativeWsfu.get(), 2.2, 1e-9); // WC WSFU
  assert.equal(net.pipes.get('smain')!.cumulativeDfu.get(), 0);
  assert.equal(net.pipes.get('dmain')!.cumulativeWsfu.get(), 0);
});

test('a chosen catalog pipe product drives the size and shows in the BOQ', () => {
  const net = mixed();
  net.setPipeProduct('smain', { name: 'PPR PN20 Ø32mm', material: 'PPR-R', odMm: 32, pn: 20 });
  assert.equal(net.pipes.get('smain')!.sizing.get().value, 32); // product OD wins
  assert.ok(net.boq.get().some((l) => l.itemCode === 'PROD-PPR PN20 Ø32mm'));
  net.setPipeProduct('smain', null); // clear → back to auto
  assert.notEqual(net.pipes.get('smain')!.sizing.get().value, 32);
});

test('a manual size override wins over the auto size (and can be cleared)', () => {
  const net = mixed();
  const smain = net.pipes.get('smain')!;
  const auto = smain.sizing.get().value; // whatever the demand sized it to
  net.setPipeSize('smain', 63); // force Ø63
  assert.equal(smain.sizing.get().value, 63);
  net.setPipeSize('smain', null); // back to auto
  assert.equal(smain.sizing.get().value, auto);
});

test('BOQ lists both PPR supply and uPVC drain lines', () => {
  const net = mixed();
  const codes = net.boq.get().map((l) => l.itemCode);
  assert.ok(codes.some((c) => c.startsWith('PPR-OD')));
  assert.ok(codes.some((c) => c.startsWith('DRAIN-OD')));
});

test('vent system sizes from the DFU it protects (rooted at the roof terminal)', () => {
  const net = new PlumbingLayout(GULF_V1)
    .addNode('roof', 'vent-terminal', 0, 0)
    .addNode('wc', 'fixture', 3, 0, 'WaterCloset')
    .addNode('lav', 'fixture', 5, 0, 'Lavatory')
    .addNode('vj', 'junction', 2, 0)
    .addPipe('vmain', 'roof', 'vj', 'vent')
    .addPipe('vwc', 'vj', 'wc', 'vent')
    .addPipe('vlav', 'vj', 'lav', 'vent');
  approx(net.pipes.get('vmain')!.cumulativeDfu.get(), 5, 1e-9); // WC 4 + Lav 1
  assert.equal(net.pipes.get('vmain')!.sizing.get().value, 40); // 5 DFU → Ø40 vent
  assert.ok(net.boq.get().some((l) => l.itemCode.startsWith('VENT-OD')));
});

test('node elevation defaults by kind and is settable', () => {
  const net = mixed();
  approx(net.nodes.get('wc')!.z.get(), 0.5, 1e-9); // fixture default
  approx(net.nodes.get('sewer')!.z.get(), 0.1, 1e-9); // outlet default
  net.setElevation('wc', 2.4);
  approx(net.nodes.get('wc')!.z.get(), 2.4, 1e-9);
});

// Geometry decides stack vs branch: a near-vertical drainage run is a stack (stack table, no slope check).
test('layout: a vertical drainage run is classified as a stack and sized from the stack table', () => {
  const L = new PlumbingLayout(GULF_V1);
  // Upper WC on a floor above, dropping into a stack node directly below (same x,y, 3 m lower).
  L.addNode('sewer', 'outlet', 0, 0, undefined, 0);
  L.addNode('base', 'junction', 10, 0, undefined, 0);
  L.addNode('top', 'junction', 10, 0, undefined, 3); // directly above `base` → vertical
  L.addNode('wc', 'fixture', 10, 0, 'WaterCloset', 3);
  L.addPipe('bd', 'base', 'sewer', 'drainage'); // horizontal building drain
  L.addPipe('stk', 'top', 'base', 'drainage');  // vertical stack
  L.addPipe('br', 'wc', 'top', 'drainage');     // short horizontal branch
  L.setOutlet('sewer');
  const stk = L.pipes.get('stk')!;
  const bd = L.pipes.get('bd')!;
  assert.equal(stk.isStack.get(), true, 'vertical run is a stack');
  assert.equal(bd.isStack.get(), false, 'horizontal building drain is not a stack');
  // 4 DFU (one WC): horizontal table → Ø75; stack table → Ø50.
  assert.equal(stk.sizing.get().value, 50);
  assert.equal(bd.sizing.get().value, 75);
  // A stack has no horizontal slope/velocity check (reported N/A, passing).
  assert.equal(stk.slopeCheck!.get().pass, true);
});

// A stack serving N floors repeats its branch-interval DFU N times — the stack AND the building drain
// below it must both carry the multiplied load, while the per-interval figure stays per-floor.
test('layout: stackFloors multiplies DFU downstream (stack + building drain), not per-interval', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('sewer', 'outlet', 0, 0, undefined, 0);
  L.addNode('base', 'junction', 10, 0, undefined, 0);
  L.addNode('top', 'junction', 10, 0, undefined, 3); // vertical stack top→base
  L.addNode('wc', 'fixture', 10, 0, 'WaterCloset', 3); // 4 DFU per floor
  L.addPipe('bd', 'base', 'sewer', 'drainage');
  L.addPipe('stk', 'top', 'base', 'drainage');
  L.addPipe('br', 'wc', 'top', 'drainage');
  L.setOutlet('sewer');
  const stk = L.pipes.get('stk')!, bd = L.pipes.get('bd')!;
  assert.equal(stk.perIntervalDfu.get(), 4);
  assert.equal(stk.cumulativeDfu.get(), 4);
  assert.equal(bd.cumulativeDfu.get(), 4);

  L.setStackFloors('stk', 3); // 3 typical floors
  assert.equal(stk.perIntervalDfu.get(), 4, 'per-interval stays one floor');
  assert.equal(stk.cumulativeDfu.get(), 12, 'stack carries all floors');
  assert.equal(bd.cumulativeDfu.get(), 12, 'building drain carries all floors');
  assert.equal(stk.sizing.get().value, 75);  // 12 DFU on stack table
  assert.equal(bd.sizing.get().value, 110);  // 12 DFU on horizontal table
  assert.equal(stk.stackBranchCheck!.get().pass, true); // 4 ≤ 20 at Ø75
});

// A drainage run that jogs meaningfully in both plan and elevation is an offset (not a pure stack).
test('layout: a drainage run jogging in both directions is an offset, not a stack', () => {
  const L = new PlumbingLayout(GULF_V1);
  L.addNode('a', 'junction', 0, 0, undefined, 3);
  L.addNode('b', 'junction', 5, 0, undefined, 0); // 5 m run, 3 m drop
  L.addPipe('off', 'a', 'b', 'drainage');
  assert.equal(L.pipes.get('off')!.isOffset.get(), true);
  assert.equal(L.pipes.get('off')!.isStack.get(), false);
});
