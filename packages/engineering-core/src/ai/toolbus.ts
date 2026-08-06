/**
 * Copilot Tool Bus (Doc 06 §2, Doc 08 §2.7). The AI does not compute engineering values — it calls
 * TOOLS that hit the deterministic rules engine, and every number it may state has to come from a
 * recorded tool result. This module is the substrate for that: it registers tools, records their
 * outputs, and exposes the set of "grounded" numbers the guardrail (guardrail.ts) checks against.
 */

export type SideEffect = 'read' | 'propose' | 'apply';

export interface ToolDef<A, R> {
  readonly name: string;
  readonly sideEffect: SideEffect;
  run(args: A): R;
}

export interface ToolCallRecord {
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
}

export class ToolBus {
  private readonly tools = new Map<string, ToolDef<unknown, unknown>>();
  readonly calls: ToolCallRecord[] = [];

  register<A, R>(tool: ToolDef<A, R>): this {
    this.tools.set(tool.name, tool as ToolDef<unknown, unknown>);
    return this;
  }

  call<A, R>(name: string, args: A): R {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`No tool registered as '${name}'`);
    const result = tool.run(args) as R;
    this.calls.push({ tool: name, args, result });
    return result;
  }

  /** Every number that appeared in a tool result so far — the evidence the AI is allowed to cite. */
  groundedNumbers(): number[] {
    const out: number[] = [];
    for (const call of this.calls) collectNumbers(call.result, out);
    return out;
  }
}

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  const matches = text.match(NUMBER_RE);
  if (matches) for (const s of matches) out.push(Number.parseFloat(s));
  return out;
}

function collectNumbers(value: unknown, out: number[]): void {
  if (typeof value === 'number') {
    out.push(value);
  } else if (typeof value === 'string') {
    for (const n of extractNumbers(value)) out.push(n);
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
}
