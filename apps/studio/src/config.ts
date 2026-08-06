import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runtime configuration, resolved once at boot from the environment.
 *
 * Defaults are chosen so that an unconfigured process is safe rather than convenient: the server
 * binds to loopback, registration is closed unless asked for, and a missing session secret is a
 * hard failure in production instead of a silently generated one.
 */

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type AuthMode = 'accounts' | 'open';

export interface Config {
  readonly appRoot: string;
  readonly publicDir: string;
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly production: boolean;
  /**
   * `accounts` requires a signed-in user for every API call. `open` skips authentication and binds
   * every request to a single local workspace; it exists so the project can be evaluated with one
   * command, and it refuses to start on a non-loopback host.
   */
  readonly authMode: AuthMode;
  readonly allowRegistration: boolean;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;
  /** Set when TLS is terminated upstream, so session cookies are still issued with `Secure`. */
  readonly behindTlsProxy: boolean;
  readonly limits: {
    readonly jsonBodyBytes: number;
    readonly meshBodyBytes: number;
    readonly eventsPerRequest: number;
    readonly eventsPerDocument: number;
    readonly documentsInMemory: number;
    readonly customCatalogItems: number;
    readonly projectsPerWorkspace: number;
    readonly sseClientsPerWorkspace: number;
  };
  readonly ai: {
    readonly enabled: boolean;
    readonly apiKey: string | null;
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxToolTurns: number;
  };
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be a boolean (got "${raw}")`);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = (env.NODE_ENV ?? 'development') === 'production';
  const host = env.HOST?.trim() || '127.0.0.1';
  const authMode: AuthMode = (env.BG_AUTH_MODE?.trim() || 'accounts') as AuthMode;

  if (authMode !== 'accounts' && authMode !== 'open') {
    throw new Error(`BG_AUTH_MODE must be "accounts" or "open" (got "${env.BG_AUTH_MODE}")`);
  }
  if (authMode === 'open' && !LOOPBACK.has(host)) {
    throw new Error('BG_AUTH_MODE=open serves an unauthenticated workspace and is only allowed on a loopback HOST');
  }
  if (authMode === 'open' && production) {
    throw new Error('BG_AUTH_MODE=open is not allowed when NODE_ENV=production');
  }

  let sessionSecret = env.BG_SESSION_SECRET?.trim() ?? '';
  if (sessionSecret.length === 0) {
    if (production) throw new Error('BG_SESSION_SECRET is required in production — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    // Development: a per-process secret. Sessions do not survive a restart, which is the intent.
    sessionSecret = randomBytes(32).toString('hex');
  } else if (sessionSecret.length < 32) {
    throw new Error('BG_SESSION_SECRET must be at least 32 characters');
  }

  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;

  return {
    appRoot: APP_ROOT,
    publicDir: join(APP_ROOT, 'public'),
    dataDir: env.BG_DATA_DIR?.trim() ? resolve(env.BG_DATA_DIR.trim()) : join(APP_ROOT, 'data'),
    host,
    port: envInt(env, 'PORT', 4317),
    production,
    authMode,
    allowRegistration: envBool(env, 'BG_ALLOW_REGISTRATION', !production),
    sessionSecret,
    sessionTtlMs: envInt(env, 'BG_SESSION_TTL_HOURS', 12) * 60 * 60 * 1000,
    behindTlsProxy: envBool(env, 'BG_BEHIND_TLS_PROXY', false),
    limits: {
      jsonBodyBytes: envInt(env, 'BG_MAX_JSON_BYTES', 1_000_000),
      meshBodyBytes: envInt(env, 'BG_MAX_MESH_BYTES', 24_000_000),
      eventsPerRequest: envInt(env, 'BG_MAX_EVENTS_PER_REQUEST', 2_000),
      eventsPerDocument: envInt(env, 'BG_MAX_EVENTS_PER_DOCUMENT', 100_000),
      documentsInMemory: envInt(env, 'BG_MAX_DOCUMENTS_IN_MEMORY', 200),
      customCatalogItems: envInt(env, 'BG_MAX_CUSTOM_CATALOG_ITEMS', 2_000),
      projectsPerWorkspace: envInt(env, 'BG_MAX_PROJECTS_PER_WORKSPACE', 200),
      sseClientsPerWorkspace: envInt(env, 'BG_MAX_SSE_CLIENTS', 25),
    },
    ai: {
      enabled: apiKey !== null,
      apiKey,
      model: env.ANTHROPIC_MODEL?.trim() || 'claude-opus-4-8',
      timeoutMs: envInt(env, 'BG_AI_TIMEOUT_MS', 60_000),
      maxToolTurns: envInt(env, 'BG_AI_MAX_TOOL_TURNS', 5),
    },
  };
}
