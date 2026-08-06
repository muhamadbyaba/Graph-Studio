import type { PlumbingLayout } from '../model/layout.ts';
import { round } from '../boq/boq.ts';

/**
 * Grounded design assistant (Doc 06). It answers questions about the CURRENT model using only values
 * the engine computed — validation, cost, sizes, quantities, and the sizing trace. There is no LLM
 * here, so it cannot hallucinate a number: every figure is read from the deterministic model. A live
 * LLM can be layered on top later, calling the same read functions as tools (the guardrail already
 * enforces "numbers only from tools"). This function is the tool layer, made directly useful.
 */

export interface AskContext {
  readonly selectedPipeId?: string;
}

const money = (n: number) => `$${round(n, 2)}`;

export function answerQuestion(layout: PlumbingLayout, question: string, ctx: AskContext = {}): string {
  const q = question.toLowerCase().trim();
  const pipes = [...layout.pipes.values()];
  const nodes = [...layout.nodes.values()];
  const isFail = (p: (typeof pipes)[number]) => {
    const s = p.sizing.get().pass === false;
    const v = p.velocity.get().pass === false;
    const sl = p.slopeCheck ? p.slopeCheck.get().pass === false : false;
    return s || v || sl;
  };

  if (!q) return 'Ask me about your design — try “what fails?”, “total cost”, “why this size?”, or “how many fixtures?”.';

  // --- validation ---
  if (/(valid|fail|problem|issue|wrong|violation|over limit|check|error|ok\b)/.test(q)) {
    const fails = pipes.filter(isFail);
    if (pipes.length === 0) return 'Nothing drawn yet — place items and connect them, then ask again.';
    if (fails.length === 0) return `✓ All ${pipes.length} runs pass validation. No issues found.`;
    const lines = fails.map((p) => {
      const reason = p.sizing.get().pass === false ? 'no standard size fits (run too long / load too high)'
        : p.velocity.get().pass === false ? (p.medium === 'power' ? 'voltage drop over limit' : p.medium === 'drainage' ? 'velocity below self-cleansing' : 'velocity over limit')
        : 'below minimum slope';
      return `• ${p.id} (${p.medium}): ${reason}`;
    });
    return `Found ${fails.length} issue(s):\n${lines.join('\n')}\nTip: select the item to see the trace, or use ⚡ Assist to auto-fix slopes.`;
  }

  // --- cost ---
  if (/(cost|price|total|budget|money|expensive|estimate|how much)/.test(q)) {
    const boq = layout.boq.get();
    if (boq.length === 0) return 'No quantities yet — draw something and I’ll price it.';
    const byGroup: Record<string, number> = {};
    let total = 0;
    for (const l of boq) { const c = (l.rate ?? 0) * l.qty; total += c; byGroup[l.group ?? 'Other'] = (byGroup[l.group ?? 'Other'] ?? 0) + c; }
    const parts = Object.entries(byGroup).sort().map(([g, c]) => `${g} ${money(c)}`);
    return `Project cost ≈ ${money(total)}.\nBy discipline: ${parts.join(' · ')}.\n(Representative rates — VERIFY against a real cost database.)`;
  }

  // --- why / explain a size (uses the selected item, or a pipe id in the question) ---
  if (/(why|explain|reason|trace|how did|justify)/.test(q)) {
    let pid = ctx.selectedPipeId;
    if (!pid) { const m = q.match(/\b(p[_a-z0-9]{2,})\b/); if (m) pid = m[1]; }
    const p = pid ? layout.pipes.get(pid) : undefined;
    if (!p) return 'Select a pipe / cable / duct / beam first, then ask “why this size?” — I’ll show the full sizing reasoning.';
    const t = p.sizing.get().trace;
    const steps = t.steps.slice(0, 6).map((s) => `${s.expr} → ${s.result}`).join('; ');
    return `${p.id} (${p.medium}) → size ${p.sizing.get().value}.\nRule: ${t.formula}.\n${steps}.\nClause: ${t.clause}.`;
  }

  // --- quantities / counts ---
  if (/(how many|count|number of|fixture|quantit|length|metre|meter|total length)/.test(q)) {
    const fixtures = nodes.filter((n) => n.kind === 'fixture');
    const byType: Record<string, number> = {};
    for (const f of fixtures) { const t = f.fixtureType?.get() ?? '?'; byType[t] = (byType[t] ?? 0) + 1; }
    const byLen: Record<string, number> = {};
    for (const p of pipes) byLen[p.medium] = (byLen[p.medium] ?? 0) + p.lengthM.get();
    const fx = Object.entries(byType).map(([t, n]) => `${n}× ${t}`).join(', ') || 'none';
    const ln = Object.entries(byLen).map(([m, l]) => `${m} ${round(l, 1)} m`).join(', ') || 'none';
    return `Fixtures: ${fx}.\nRun lengths: ${ln}.\nElements: ${nodes.length} nodes, ${pipes.length} runs.`;
  }

  // --- longest / biggest ---
  if (/(long|biggest|largest|worst)/.test(q) && pipes.length) {
    const longest = pipes.reduce((a, b) => (b.lengthM.get() > a.lengthM.get() ? b : a));
    return `Longest run: ${longest.id} (${longest.medium}), ${round(longest.lengthM.get(), 2)} m, size ${longest.sizing.get().value}.`;
  }

  // --- summary / overview ---
  if (/(summary|overview|status|tell me|describe|what.*have)/.test(q)) {
    const fixtures = nodes.filter((n) => n.kind === 'fixture').length;
    const fails = pipes.filter(isFail).length;
    const boq = layout.boq.get();
    const total = boq.reduce((s, l) => s + (l.rate ?? 0) * l.qty, 0);
    const systems = [...new Set(pipes.map((p) => p.medium))].join(', ') || 'none';
    return `Design summary: ${fixtures} fixtures, ${pipes.length} runs across ${systems}. ${fails === 0 ? 'All checks pass.' : `${fails} item(s) need attention.`} Estimated cost ${money(total)}.`;
  }

  return 'I can answer about **validation** (“what fails?”), **cost** (“total cost”), **sizing** (“why this size?” with an item selected), **quantities** (“how many fixtures?”), and a **summary**. Every number I give is computed by the engine — no guessing.';
}
