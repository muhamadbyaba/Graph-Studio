import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { readJsonFile, writeJsonFile } from '../storage/json-file.ts';

/**
 * Server-side sessions carried in a cookie.
 *
 * The cookie holds a 256-bit random token and nothing else — no user id, no claims, nothing an
 * attacker can read or tamper with. The server stores only the SHA-256 of that token, so the
 * session file is not a credential: someone who reads it off disk still cannot mint a valid cookie.
 * That is the same reason password digests are stored rather than passwords.
 *
 * Sessions are persisted, so restarting the server does not sign everyone out, and expiry is
 * enforced on lookup as well as by a periodic sweep so a stale record can never be honoured.
 */

const COOKIE_NAME = 'bg_session';
const TOKEN_BYTES = 32;

interface SessionRecord {
  /** SHA-256 of the token, hex. The token itself is never written down. */
  readonly tokenHash: string;
  readonly userId: string;
  readonly createdAt: number;
  expiresAt: number;
}

export interface Session {
  readonly userId: string;
  readonly expiresAt: number;
}

export class SessionStore {
  private readonly path: string;
  private readonly ttlMs: number;
  private records = new Map<string, SessionRecord>();
  private sweepTimer: NodeJS.Timeout | null = null;

  private constructor(path: string, ttlMs: number) {
    this.path = path;
    this.ttlMs = ttlMs;
  }

  static async open(dataDir: string, ttlMs: number): Promise<SessionStore> {
    const store = new SessionStore(join(dataDir, 'sessions.json'), ttlMs);
    const saved = await readJsonFile<SessionRecord[]>(store.path, []);
    const now = Date.now();
    for (const record of saved) {
      if (typeof record?.tokenHash === 'string' && record.expiresAt > now) store.records.set(record.tokenHash, record);
    }
    store.sweepTimer = setInterval(() => void store.sweep(), 10 * 60 * 1000);
    store.sweepTimer.unref();
    return store;
  }

  /** Issue a session and return the raw token — the only moment it exists outside the client. */
  async create(userId: string): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.records.set(hashToken(token), { tokenHash: hashToken(token), userId, createdAt: Date.now(), expiresAt });
    await this.persist();
    return { token, expiresAt };
  }

  lookup(token: string | null): Session | null {
    if (token === null || token.length === 0) return null;
    const record = this.records.get(hashToken(token));
    if (record === undefined) return null;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(record.tokenHash);
      return null;
    }
    return { userId: record.userId, expiresAt: record.expiresAt };
  }

  async destroy(token: string | null): Promise<void> {
    if (token === null) return;
    if (this.records.delete(hashToken(token))) await this.persist();
  }

  /** Invalidate every session for a user, e.g. after a password change. */
  async destroyAllFor(userId: string): Promise<void> {
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.userId === userId) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    await this.persist();
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(key);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    await writeJsonFile(this.path, [...this.records.values()]);
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Parse a single cookie out of a request header without pulling in a cookie library. */
export function readSessionCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function sessionCookie(token: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Strict is viable because the app is a single origin with no cross-site entry points, and it
    // removes the entire cross-site request forgery class before the Origin check even runs.
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  const attributes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** Constant-time string equality for comparing opaque tokens. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
