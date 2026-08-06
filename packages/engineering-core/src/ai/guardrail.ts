import { extractNumbers } from './toolbus.ts';

/**
 * The numeric guardrail (Doc 06 §2, §6) — the single most important safety property in the platform:
 * an AI response may only assert engineering numbers that came from a tool result. Any number in the
 * drafted answer that is not backed by the recorded tool outputs is flagged as ungrounded, and the
 * orchestrator must reject/regenerate rather than show it.
 *
 * This is a pragmatic guard demonstrating the principle. A production system pairs it with structured
 * tool-cited values (each claim carries the tool + field it came from); the check here — every stated
 * number must match a tool-produced number — is the backstop that fails closed.
 */

export interface GuardResult {
  readonly ok: boolean;
  readonly ungrounded: number[];
}

function close(a: number, b: number, relTol: number): boolean {
  return Math.abs(a - b) <= relTol * Math.max(1, Math.abs(a));
}

export function guardNumericClaims(answer: string, groundedNumbers: readonly number[], relTol = 0.01): GuardResult {
  const claimed = extractNumbers(answer);
  const ungrounded = claimed.filter((n) => !groundedNumbers.some((g) => close(g, n, relTol)));
  return { ok: ungrounded.length === 0, ungrounded };
}
