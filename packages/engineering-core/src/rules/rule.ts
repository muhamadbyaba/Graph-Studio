import type { Quantity } from '../units/quantity.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * The Rule contract (Doc 03 §1, Doc 08 §2.3).
 *
 * A rule is a PURE function of (inputs, jurisdiction) that returns a value, an optional pass/fail,
 * a severity, and — always — a full `trace`. The trace is simultaneously the engineer's
 * justification, the AI copilot's explanation, and the liability record. No trace, no ship.
 */

export type Severity = 'info' | 'warn' | 'violation';

export interface TraceStep {
  readonly expr: string;
  readonly result: string;
}

export interface Trace {
  readonly formula: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly steps: readonly TraceStep[];
  readonly clause: string;
  readonly assumptions: readonly string[];
}

export type RuleValue = Quantity | number | string | boolean | null;

export interface RuleResult {
  readonly value: RuleValue;
  readonly pass?: boolean;
  readonly severity?: Severity;
  readonly trace: Trace;
}

export interface RuleContext {
  readonly jurisdiction: JurisdictionPack;
}

export interface Rule<I> {
  readonly id: string;
  readonly discipline: string;
  readonly standardRef: string;
  readonly assumptions: readonly string[];
  evaluate(inputs: I, ctx: RuleContext): RuleResult;
}
