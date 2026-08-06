import { answerQuestion } from '@buildgraph/engineering-core';
import type { PlumbingLayout } from '@buildgraph/engineering-core';
import type { Config } from '../config.ts';
import type { StateSnapshot } from '../model/serialize.ts';

/**
 * The design copilot.
 *
 * The load-bearing property is that the model cannot originate an engineering number. It is given
 * two read-only tools over the current design and a system prompt that forbids inventing figures;
 * every quantity it can state has already been computed by the deterministic rules engine, so
 * "grounded" is a structural fact rather than a request. Prose comes from the model, arithmetic
 * never does.
 *
 * When no API key is configured — or the API is unreachable, slow or erroring — the request falls
 * back to the engine's own deterministic answering path rather than failing. An engineer asking
 * "what fails?" gets an answer either way; only the fluency changes.
 *
 * Raw HTTP rather than the SDK: the server runs on Node's native TypeScript with no build step and
 * no runtime dependencies, and adding one for a single POST would trade that away. The Messages API
 * shape is stable and versioned by the `anthropic-version` header.
 */

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_QUESTION_LENGTH = 2000;

export type CopilotMode = 'ai' | 'grounded';

export interface CopilotAnswer {
  readonly answer: string;
  readonly mode: CopilotMode;
}

const TOOLS = [
  {
    name: 'get_project_state',
    description: 'The current engineering model: every pipe, duct and cable with its computed size, length, demand or load, velocity, head loss and pass/fail status; fixtures; reinforced-concrete columns and slabs with their sizing; the priced Bill of Quantities by discipline; the project cost total; and the active code jurisdiction. Call this first for any question about the design.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'explain_element',
    description: 'The full step-by-step sizing calculation and the code clause for one element id (pipe, member, column or slab). Use this for "why this size" or "show the calculation" questions.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the element id, for example a pipe or column tag' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export class Copilot {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.ai.enabled;
  }

  async ask(layout: PlumbingLayout, state: StateSnapshot, question: string, selectedElementId?: string): Promise<CopilotAnswer> {
    const trimmed = question.trim().slice(0, MAX_QUESTION_LENGTH);
    const grounded = (): string => answerQuestion(layout, trimmed, { selectedPipeId: selectedElementId });

    if (!this.config.ai.enabled) return { answer: grounded(), mode: 'grounded' };

    try {
      return { answer: await this.askModel(state, trimmed, selectedElementId), mode: 'ai' };
    } catch (err) {
      // The upstream message can carry request detail; log it, but never return it to the client.
      console.warn('[copilot] falling back to the deterministic engine:', err instanceof Error ? err.message : err);
      return {
        answer: `${grounded()}\n\n(The live assistant was unavailable, so this answer came straight from the engine.)`,
        mode: 'grounded',
      };
    }
  }

  private async askModel(state: StateSnapshot, question: string, selectedElementId?: string): Promise<string> {
    const system = [
      'You are the design copilot inside BuildGraph Studio, an MEP and structural design tool.',
      'Answer the engineer\'s question using ONLY facts returned by the tools. Never invent or estimate sizes, quantities, loads, velocities or costs — every figure you state must come from a tool result.',
      'Call get_project_state first; use explain_element for "why this size" questions.',
      'Be concise and technically precise. Units: mm for pipe and duct diameters and structural sections, L/s for flow, m for length and head loss, kN for loads, % for utilisation.',
      'All output is decision-support, subject to Engineer-of-Record sign-off.',
      `Active jurisdiction: ${state.jurisdiction}.`,
      selectedElementId ? `The engineer currently has element "${selectedElementId}" selected.` : '',
    ].filter(Boolean).join(' ');

    const messages: unknown[] = [{ role: 'user', content: question }];

    for (let turn = 0; turn < this.config.ai.maxToolTurns; turn++) {
      const response = await this.postMessages({ system, tools: TOOLS, messages });

      if (response.stop_reason !== 'tool_use') {
        const text = (response.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim();
        return text.length > 0 ? text : 'The assistant returned no text — try rephrasing the question.';
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: (response.content ?? [])
          .filter((block) => block.type === 'tool_use')
          .map((block) => ({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(this.runTool(state, block.name ?? '', block.input)),
          })),
      });
    }
    return 'The assistant kept requesting data without answering — try a more specific question.';
  }

  private runTool(state: StateSnapshot, name: string, input: unknown): unknown {
    switch (name) {
      case 'get_project_state': return modelFacts(state);
      case 'explain_element': return elementTrace(state, String((input as { id?: unknown } | null)?.id ?? ''));
      default: return { error: `unknown tool "${name}"` };
    }
  }

  private async postMessages(body: Record<string, unknown>): Promise<AnthropicResponse> {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.ai.apiKey as string,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: this.config.ai.model, max_tokens: 1024, ...body }),
      signal: AbortSignal.timeout(this.config.ai.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Anthropic API returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return await response.json() as AnthropicResponse;
  }
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  stop_reason?: string;
  content?: AnthropicContentBlock[];
}

/**
 * A compact, token-lean snapshot of the model — the only facts the copilot is allowed to use.
 * Deliberately narrower than the full state: geometry, traces and internal ids that would not help
 * an answer are left out so the context stays small and the model stays on the engineering.
 */
export function modelFacts(state: StateSnapshot): unknown {
  const fixtures: Record<string, number> = {};
  for (const n of state.nodes) {
    if (n.kind !== 'fixture') continue;
    const label = String(n.fixtureType).replace(/([a-z])([A-Z])/g, '$1 $2');
    fixtures[label] = (fixtures[label] ?? 0) + 1;
  }

  const pressure = state.pressure as Record<string, any> | null;
  const recirc = state.recirc as Record<string, any> | null;
  const dwv = state.dwv as Record<string, any> | null;

  return {
    jurisdiction: state.jurisdiction,
    project: state.meta,
    fixtures,
    pipes: state.pipes.map((p) => ({
      id: p.id, system: p.medium, sizeOd: p.sizeOd, lengthM: p.lengthM,
      demandLps: p.demandLps, velocityMs: p.velocityMs, headlossM: p.headlossM,
      dfu: p.cumulativeDfu, amps: p.cumulativeAmps, airLps: p.cumulativeAirLps, slopePct: p.slopePct,
      ok: p.sizePass !== false && p.velocityPass !== false && p.slopePass !== false,
      reinforcement: p.reinf, beamLoadKnPerM: p.beamLoad,
    })),
    columns: state.nodes.filter((n) => n.kind === 'support' && n.column !== null).map((n) => ({
      id: n.id, section: n.column!.size, floors: n.floorsSupported, totalPuKn: n.axialLoadKn,
      capacity: n.column!.capacity, utilization: n.column!.utilization,
      reinforcement: n.column!.reinforcement, ok: n.column!.pass !== false,
    })),
    slabs: (state.slabs ?? []).map((s) => ({
      id: s.id, areaM2: s.areaM2, type: s.type, thicknessMm: s.thickness,
      steel: s.steel, spans: `${s.shortSpan}/${s.longSpan}`, ok: s.pass !== false,
    })),
    fittings: state.nodes.filter((n) => n.kind === 'fitting').length,
    hydraulics: pressure === null ? null : {
      supplyPressureKPa: pressure.supplyPressureKPa,
      minResidualKPa: pressure.minResidualKPa,
      maxPressureKPa: pressure.maxPressureKPa,
      allFixturesOk: pressure.allPass,
      fixturesBelowMinimum: pressure.failing,
      fixturesOverMaximum: pressure.overpressure,
      criticalFixture: pressure.worst,
      totalHeadLossToCriticalM: pressure.totalFrictionM,
      fittingLossToCriticalM: pressure.minorToCriticalM,
      fittingsOnCriticalPath: pressure.criticalFittings,
      autoFix: pressure.remedy,
      assumptions: pressure.assumptions,
    },
    hotRecirculation: recirc?.active ? {
      recircFlowLps: recirc.recircFlowLps,
      pumpHeadKPa: recirc.pumpHeadKPa,
      loopLengthM: recirc.loopLengthM,
      loopFrictionM: recirc.frictionM,
      returnVelocityMps: recirc.returnVelocityMps,
      branches: (recirc.branches ?? []).map((b: Record<string, unknown>) => ({
        returnPipe: b.returnPipeId, flowLps: b.flowLps, frictionM: b.frictionM,
        index: b.isIndex, balancingValveKv: b.balanceValveKv, balanceHeadM: b.balanceHeadM,
      })),
    } : null,
    drainageVentValidation: dwv?.active ? {
      totalDfu: dwv.totalDfu,
      hasVentSystem: dwv.hasVentSystem,
      everyFixtureDrained: dwv.allDrained,
      everyTrapVented: dwv.allVented,
      orphanedDrains: dwv.unconnectedDrains,
      unventedFixtures: dwv.unventedFixtures,
    } : null,
    boq: state.boq.map((l) => ({ item: l.description, qty: l.qty, unit: l.unit, discipline: l.group, amount: l.lineCost })),
    costTotal: state.costTotal,
  };
}

/** The step-by-step sizing calculation and code clause for one element. */
export function elementTrace(state: StateSnapshot, id: string): unknown {
  const pipe = state.pipes.find((p) => p.id === id);
  if (pipe !== undefined) return { id, kind: 'pipe/member', steps: pipe.sizeSteps, clause: pipe.clause };

  const column = state.nodes.find((n) => n.id === id && n.column !== null);
  if (column !== undefined) return { id, kind: 'column', steps: column.column!.steps, clause: column.column!.clause };

  const slab = (state.slabs ?? []).find((s) => s.id === id);
  if (slab !== undefined) return { id, kind: 'slab', steps: slab.steps, clause: slab.clause };

  return { id, error: 'no element with that id — call get_project_state to see the valid ids' };
}
