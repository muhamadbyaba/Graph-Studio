import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JURISDICTIONS } from '@buildgraph/engineering-core';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { AccountStore } from '../src/auth/accounts.ts';
import { SessionStore } from '../src/auth/sessions.ts';
import { DocumentRegistry } from '../src/model/documents.ts';
import { RealtimeHub } from '../src/realtime/hub.ts';
import { CatalogStore } from '../src/storage/catalog.ts';
import { ProjectStore } from '../src/storage/projects.ts';
import { Copilot } from '../src/copilot/copilot.ts';
import { RateLimiter } from '../src/http/rate-limit.ts';
import { buildRouter, createRequestHandler } from '../src/app.ts';
import type { Services } from '../src/app.ts';

/**
 * Boot a real server on an ephemeral port against a throwaway data directory.
 *
 * The tests drive the actual HTTP surface — cookies, status codes, headers — rather than calling
 * handlers directly, because the properties worth testing here (a session is required, a workspace
 * you do not belong to is invisible, a cross-site POST is refused) live in the pipeline, not in any
 * single function.
 */

export interface TestServer {
  readonly url: string;
  readonly services: Services;
  client(): TestClient;
  close(): Promise<void>;
}

export interface Response<T = any> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export class TestClient {
  private cookie: string | null = null;
  private workspaceId: string | null = null;
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  useWorkspace(id: string | null): this {
    this.workspaceId = id;
    return this;
  }

  get session(): string | null {
    return this.cookie;
  }

  async request<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response<T>> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie !== null) headers.cookie = this.cookie;
    if (this.workspaceId !== null && headers['x-workspace'] === undefined) headers['x-workspace'] = this.workspaceId;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });

    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const raw of setCookie) {
      const pair = raw.split(';')[0];
      this.cookie = pair.endsWith('=') ? null : pair;
    }

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch { /* html, csv, or an empty body */ }
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  get<T = any>(path: string, headers?: Record<string, string>): Promise<Response<T>> {
    return this.request<T>('GET', path, undefined, headers);
  }

  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response<T>> {
    return this.request<T>('POST', path, body ?? {}, headers);
  }

  /** Register an account and adopt its session and default workspace. */
  async signUp(username: string, password = 'harness-test-secret'): Promise<{ id: string; username: string }> {
    const res = await this.post('/api/auth/register', { username, password });
    if (res.status !== 201) throw new Error(`registration failed: ${JSON.stringify(res.body)}`);
    const workspaces = await this.get('/api/workspaces');
    this.workspaceId = workspaces.body.active;
    return res.body.user;
  }
}

export async function startTestServer(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'buildgraph-test-'));
  const config: Config = loadConfig({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    // No PORT: the harness binds an ephemeral one itself so suites can run in parallel.
    BG_AUTH_MODE: 'accounts',
    BG_ALLOW_REGISTRATION: 'true',
    BG_SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
    BG_DATA_DIR: dataDir,
    ...overrides,
  } as NodeJS.ProcessEnv);

  const hub = new RealtimeHub({ maxClientsPerRoom: config.limits.sseClientsPerWorkspace });
  const services: Services = {
    config,
    inlineScriptSources: [],
    accounts: await AccountStore.open(config.dataDir),
    sessions: await SessionStore.open(config.dataDir, config.sessionTtlMs),
    documents: new DocumentRegistry(config, JURISDICTIONS, (id) => hub.hasSubscribers(id)),
    projects: new ProjectStore(config.dataDir, config.limits.projectsPerWorkspace),
    catalog: await CatalogStore.open(config.dataDir, config.limits.customCatalogItems),
    copilot: new Copilot(config),
    hub,
    limiters: {
      // Generous in tests: the limiter has its own unit test, and a shared address would otherwise
      // make unrelated cases fail depending on execution order.
      signIn: new RateLimiter({ limit: 1000, windowMs: 60_000, label: 'sign-in' }),
      register: new RateLimiter({ limit: 1000, windowMs: 60_000, label: 'registration' }),
      copilot: new RateLimiter({ limit: 1000, windowMs: 60_000, label: 'assistant' }),
      heavy: new RateLimiter({ limit: 1000, windowMs: 60_000, label: 'model import' }),
      write: new RateLimiter({ limit: 100_000, windowMs: 60_000, label: 'edit' }),
    },
  };

  const server: Server = createServer(createRequestHandler(services, buildRouter()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    services,
    client: () => new TestClient(url),
    async close() {
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await services.documents.closeAll();
      await services.sessions.close();
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** A minimal, valid design: a tank, two fixtures and a cold run. */
export const SAMPLE_EDITS = [
  { type: 'NodeAdded', id: 'lav', kind: 'fixture', x: 14, y: 7, fixtureType: 'Lavatory' },
  { type: 'PipeAdded', id: 'p_lav', from: 'tank', to: 'lav', medium: 'cold' },
];
