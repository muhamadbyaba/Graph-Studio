import { Source, Derived, source, derived } from '../core/reactive.ts';
import { hunterDemand } from '../plumbing/demand.ts';
import { sizeSupplyPipeRule } from '../plumbing/sizing.ts';
import { velocityCheckRule } from '../plumbing/rules.ts';
import { pprInnerDiameter } from '../plumbing/hydraulics.ts';
import { qty, mm, lps } from '../units/index.ts';
import { aggregate, round } from '../boq/boq.ts';
import type { BoqLine } from '../boq/boq.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';
import type { RuleContext, RuleResult } from '../rules/rule.ts';

/**
 * A reactive plumbing supply network (Doc 02 §3.1, plumbing spec §6). Objects and connections are
 * plain data; a `topoVersion` signal makes structural changes reactive, while each object's
 * mutable inputs are their own signals. Derived engineering properties (cumulative WSFU → demand
 * → size → velocity → BOQ) are computed lazily and incrementally: editing one thing recomputes
 * only what depends on it. This is the "every change updates every connected system" promise,
 * running.
 *
 * Scope note: this reference network models a supply tree rooted at a source (tank/riser). It is
 * deliberately small but the traversal + reactivity are general. Pressure balance, drainage, and
 * venting are separate rules layered on the same pattern (plumbing spec §3).
 */

export type Medium = 'cold' | 'hot';
type NodeKind = 'source' | 'pipe' | 'fixture';

export interface FixtureCell {
  readonly id: string;
  readonly type: Source<string>;
  readonly wsfu: Derived<number>;
}

export interface PipeCell {
  readonly id: string;
  readonly medium: Medium;
  readonly lengthM: Source<number>;
  readonly cumulativeWsfu: Derived<number>;
  readonly demandLps: Derived<number>;
  readonly sizing: Derived<RuleResult>;
  readonly velocity: Derived<RuleResult>;
}

export class PlumbingNetwork {
  private readonly pack: JurisdictionPack;
  private readonly ctx: RuleContext;
  private readonly adjacency = new Map<string, Set<string>>();
  private readonly kinds = new Map<string, NodeKind>();
  private sourceId: string | null = null;
  private readonly topoVersion: Source<number> = source(0);
  /** nodeId → list of fixture ids in its subtree (recomputed on topology change). */
  private readonly topology: Derived<Map<string, string[]>>;

  readonly fixtures = new Map<string, FixtureCell>();
  readonly pipes = new Map<string, PipeCell>();
  readonly boq: Derived<BoqLine[]>;

  constructor(pack: JurisdictionPack) {
    this.pack = pack;
    this.ctx = { jurisdiction: pack };

    this.topology = derived(() => {
      this.topoVersion.get(); // dependency: recompute when structure changes
      return descendantFixtures(this.adjacency, this.kinds, this.sourceId);
    });

    this.boq = derived(() => {
      this.topoVersion.get(); // depends on the current object set
      const lines: BoqLine[] = [];
      for (const p of this.pipes.values()) {
        const od = p.sizing.get().value as number | null;
        const len = p.lengthM.get();
        if (od !== null) {
          const pn = this.pack.supply.pprCatalog.find((s) => s.odMm === od)?.pn ?? 0;
          lines.push({
            itemCode: `PPR-OD${od}-PN${pn}-${p.medium}`,
            description: `PPR pipe OD${od} PN${pn} (${p.medium})`,
            unit: 'm',
            qty: round(len * 1.05, 3), // +5% waste [VERIFY]
          });
        }
      }
      for (const f of this.fixtures.values()) {
        const t = f.type.get();
        lines.push({ itemCode: `FIX-${t}`, description: t, unit: 'nr', qty: 1 });
      }
      return aggregate(lines);
    });
  }

  private ensureNode(id: string): void {
    if (!this.adjacency.has(id)) this.adjacency.set(id, new Set());
  }

  private bump(): void {
    this.topoVersion.update((v) => v + 1);
  }

  setSource(id: string): this {
    this.ensureNode(id);
    this.kinds.set(id, 'source');
    this.sourceId = id;
    this.bump();
    return this;
  }

  addFixture(id: string, type: string): this {
    this.ensureNode(id);
    this.kinds.set(id, 'fixture');
    const typeSig = source(type);
    const wsfu = derived(() => {
      const t = typeSig.get();
      const w = this.pack.demand.wsfu[t];
      if (w === undefined) throw new Error(`No WSFU value for fixture '${t}' in ${this.pack.id}`);
      return w;
    });
    this.fixtures.set(id, { id, type: typeSig, wsfu });
    this.bump();
    return this;
  }

  addPipe(id: string, medium: Medium, lengthM: number): this {
    this.ensureNode(id);
    this.kinds.set(id, 'pipe');
    const len = source(lengthM);

    const cumulativeWsfu = derived(() => {
      const ids = this.topology.get().get(id) ?? [];
      let sum = 0;
      for (const fid of ids) {
        const f = this.fixtures.get(fid);
        if (f) sum += f.wsfu.get();
      }
      return sum;
    });
    const demandLps = derived(() => hunterDemand(cumulativeWsfu.get(), this.pack).in(lps));
    const sizing = derived(() =>
      sizeSupplyPipeRule.evaluate({ flow: qty(demandLps.get(), lps), medium }, this.ctx),
    );
    const velocity = derived(() => {
      const result = sizing.get();
      const od = result.value as number | null;
      if (od === null) return result;
      const sdr = this.pack.supply.pprCatalog.find((s) => s.odMm === od)!.sdr;
      const innerDiameter = pprInnerDiameter(qty(od, mm), sdr);
      return velocityCheckRule.evaluate({ flow: qty(demandLps.get(), lps), innerDiameter, medium }, this.ctx);
    });

    this.pipes.set(id, { id, medium, lengthM: len, cumulativeWsfu, demandLps, sizing, velocity });
    this.bump();
    return this;
  }

  connect(a: string, b: string): this {
    this.ensureNode(a);
    this.ensureNode(b);
    this.adjacency.get(a)!.add(b);
    this.adjacency.get(b)!.add(a);
    this.bump();
    return this;
  }
}

/** BFS from the source; for each node, collect the fixture ids in its subtree (children away from source). */
function descendantFixtures(
  adjacency: Map<string, Set<string>>,
  kinds: Map<string, NodeKind>,
  sourceId: string | null,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (sourceId === null) return result;

  const parent = new Map<string, string | null>();
  const order: string[] = [];
  const visited = new Set<string>([sourceId]);
  const queue: string[] = [sourceId];
  parent.set(sourceId, null);
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of adjacency.get(n) ?? []) {
      if (!visited.has(m)) {
        visited.add(m);
        parent.set(m, n);
        queue.push(m);
      }
    }
  }

  const children = new Map<string, string[]>();
  for (const [node, p] of parent) {
    if (p !== null) {
      const list = children.get(p) ?? [];
      list.push(node);
      children.set(p, list);
    }
  }

  // process leaves→root so a node's subtree is the union of its children's subtrees
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    const acc: string[] = [];
    if (kinds.get(n) === 'fixture') acc.push(n);
    for (const c of children.get(n) ?? []) {
      for (const f of result.get(c) ?? []) acc.push(f);
    }
    result.set(n, acc);
  }
  return result;
}
