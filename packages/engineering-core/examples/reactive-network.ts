/**
 * Demo: "every change updates every connected system." Build a villa cold-water branch, print its
 * size + BOQ, then add one fixture and watch the pipe auto-resize and the BOQ re-fold — with no
 * manual recompute call anywhere.
 *
 * Run:  node examples/reactive-network.ts
 */
import { PlumbingNetwork } from '../src/model/network.ts';
import { GULF_V1 } from '../src/jurisdiction/gulf.ts';

const net = new PlumbingNetwork(GULF_V1)
  .setSource('tank')
  .addPipe('p1', 'cold', 6)
  .addFixture('wc', 'WaterCloset')
  .addFixture('lav', 'Lavatory')
  .addFixture('sh', 'Shower')
  .connect('tank', 'p1')
  .connect('p1', 'wc')
  .connect('p1', 'lav')
  .connect('p1', 'sh');

function report(label: string): void {
  const p1 = net.pipes.get('p1')!;
  console.log(`\n--- ${label} ---`);
  console.log(`cumulative WSFU : ${p1.cumulativeWsfu.get()}`);
  console.log(`demand          : ${p1.demandLps.get().toFixed(3)} L/s`);
  console.log(`pipe size       : OD${p1.sizing.get().value}  (velocity check: ${p1.velocity.get().pass ? 'OK' : 'FAIL'})`);
  console.log('BOQ:');
  for (const line of net.boq.get()) {
    console.log(`  ${line.itemCode.padEnd(24)} ${String(line.qty).padStart(6)} ${line.unit}   ${line.description}`);
  }
}

report('Initial: WC + Lavatory + Shower');

console.log('\n>>> engineer adds a Kitchen Sink to the same branch <<<');
net.addFixture('ks', 'KitchenSink').connect('p1', 'ks');

report('After adding Kitchen Sink (note the pipe auto-resized and BOQ updated)');
