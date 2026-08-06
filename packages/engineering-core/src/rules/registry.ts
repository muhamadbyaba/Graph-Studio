import type { Rule, RuleContext, RuleResult } from './rule.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Holds the rules and pins a single (jurisdiction, version). The same registry code serves every
 * discipline — modules only contribute Rule objects (Doc 08 §1, §2.3). Swapping the pack changes
 * every constant without touching rule logic.
 */
export class RuleRegistry {
  readonly jurisdiction: JurisdictionPack;
  private readonly rules: Map<string, Rule<unknown>>;

  constructor(jurisdiction: JurisdictionPack) {
    this.jurisdiction = jurisdiction;
    this.rules = new Map();
  }

  register<I>(rule: Rule<I>): this {
    this.rules.set(rule.id, rule as Rule<unknown>);
    return this;
  }

  get<I>(id: string): Rule<I> {
    const rule = this.rules.get(id);
    if (!rule) throw new Error(`Rule not found: '${id}' (jurisdiction ${this.jurisdiction.id}@${this.jurisdiction.version})`);
    return rule as unknown as Rule<I>;
  }

  context(): RuleContext {
    return { jurisdiction: this.jurisdiction };
  }

  evaluate<I>(id: string, inputs: I): RuleResult {
    return this.get<I>(id).evaluate(inputs, this.context());
  }
}
