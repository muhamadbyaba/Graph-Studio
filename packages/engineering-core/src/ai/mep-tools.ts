import { ToolBus } from './toolbus.ts';
import { RuleRegistry } from '../rules/registry.ts';
import { sizeSupplyPipeRule } from '../plumbing/sizing.ts';
import { sizeCableRule } from '../electrical/sizing.ts';
import { qty, lps, ampere, meter } from '../units/index.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';
import type { RuleResult } from '../rules/rule.ts';
import type { Medium } from '../model/network.ts';

/**
 * Wires the deterministic sizing rules as copilot tools. The AI calls these; the rules engine
 * produces the numbers + traces. Two disciplines, one bus — the same reuse story as everywhere else.
 */
export function buildMepToolBus(pack: JurisdictionPack): ToolBus {
  const plumbing = new RuleRegistry(pack).register(sizeSupplyPipeRule);
  const electrical = new RuleRegistry(pack).register(sizeCableRule);

  return new ToolBus()
    .register<{ demandLps: number; medium: Medium }, RuleResult>({
      name: 'plumbing.sizePipe',
      sideEffect: 'read',
      run: (a) => plumbing.evaluate('plumbing.supply.sizePipe', { flow: qty(a.demandLps, lps), medium: a.medium }),
    })
    .register<{ currentA: number; lengthM: number }, RuleResult>({
      name: 'electrical.sizeCable',
      sideEffect: 'read',
      run: (a) =>
        electrical.evaluate('electrical.power.sizeCable', {
          designCurrent: qty(a.currentA, ampere),
          lengthOneWay: qty(a.lengthM, meter),
        }),
    });
}
