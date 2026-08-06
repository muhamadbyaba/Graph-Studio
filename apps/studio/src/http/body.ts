import type { IncomingMessage } from 'node:http';
import { badRequest, tooLarge } from './errors.ts';

/**
 * Read a JSON request body with a hard byte ceiling.
 *
 * The ceiling is enforced while streaming rather than after buffering, so an oversized upload is
 * abandoned instead of being held in memory first. `content-length` is checked too, which rejects
 * the common case before a single chunk arrives.
 */
export async function readJson<T = unknown>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(`Request body exceeds the ${formatBytes(maxBytes)} limit`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) {
      req.destroy();
      throw tooLarge(`Request body exceeds the ${formatBytes(maxBytes)} limit`);
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {} as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw badRequest('Request body must be a JSON object or array');
  }
  return stripPrototypePollution(parsed) as T;
}

/**
 * Remove `__proto__` / `constructor` / `prototype` keys before the payload is used.
 *
 * `JSON.parse` produces these as ordinary own properties, but any code that later copies the object
 * key-by-key into another object (a spread, a reduce, an index assignment) can promote them into a
 * prototype write. Dropping them at the edge means no downstream code has to remember.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function stripPrototypePollution(value: unknown, depth = 0): unknown {
  if (depth > 32) throw badRequest('Request body is nested too deeply');
  if (Array.isArray(value)) return value.map((v) => stripPrototypePollution(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const clean: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    clean[key] = stripPrototypePollution(v, depth + 1);
  }
  return clean;
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${Math.round(bytes / 100_000) / 10} MB` : `${Math.round(bytes / 1000)} kB`;
}
