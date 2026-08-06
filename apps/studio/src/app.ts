import type { IncomingMessage, ServerResponse } from 'node:http';
import { JURISDICTIONS } from '@buildgraph/engineering-core';
import type { Config } from './config.ts';
import { AccountStore } from './auth/accounts.ts';
import type { UserRecord, WorkspaceAccess } from './auth/accounts.ts';
import { SessionStore, clearedSessionCookie, readSessionCookie, sessionCookie } from './auth/sessions.ts';
import { DocumentRegistry } from './model/documents.ts';
import type { WorkspaceDocument } from './model/documents.ts';
import { RealtimeHub } from './realtime/hub.ts';
import { CatalogStore } from './storage/catalog.ts';
import { ProjectStore } from './storage/projects.ts';
import { Copilot } from './copilot/copilot.ts';
import { readJson } from './http/body.ts';
import { HttpError, forbidden, notFound, unauthenticated } from './http/errors.ts';
import { RateLimiter } from './http/rate-limit.ts';
import { responder, securityHeaders } from './http/respond.ts';
import type { Responder } from './http/respond.ts';
import { serveStatic } from './http/static.ts';
import { serializeDocument } from './model/serialize.ts';
import type { StateSnapshot } from './model/serialize.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerWorkspaceRoutes } from './routes/workspaces.ts';
import { registerDesignRoutes } from './routes/design.ts';
import { registerLibraryRoutes } from './routes/library.ts';
import { registerExportRoutes } from './routes/exports.ts';

/**
 * Application wiring: shared services, the request pipeline, and the route table.
 *
 * The pipeline is deliberately short and ordered so that the cheap, blunt checks run first —
 * security headers, same-origin enforcement, rate limiting — and authentication resolves before any
 * handler can touch a document. Handlers therefore never see an unauthenticated request or a
 * workspace the caller has no claim to; that is enforced once, here, rather than remembered in
 * twenty places.
 */

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler;
  /** Endpoints reachable without a session (sign-in, health, the app shell). */
  readonly anonymous?: boolean;
}

export class Router {
  readonly routes: Route[] = [];

  get(path: string, handler: Handler, options: { anonymous?: boolean } = {}): void {
    this.routes.push({ method: 'GET', path, handler, anonymous: options.anonymous });
  }

  post(path: string, handler: Handler, options: { anonymous?: boolean } = {}): void {
    this.routes.push({ method: 'POST', path, handler, anonymous: options.anonymous });
  }

  find(method: string, path: string): Route | undefined {
    return this.routes.find((r) => r.method === method && r.path === path);
  }
}

export interface Services {
  readonly config: Config;
  /**
   * CSP source expressions for the inline scripts the app shell legitimately contains — computed
   * from the served HTML at boot, so the policy can stay hash-based instead of `unsafe-inline`.
   */
  readonly inlineScriptSources: readonly string[];
  readonly accounts: AccountStore;
  readonly sessions: SessionStore;
  readonly documents: DocumentRegistry;
  readonly projects: ProjectStore;
  readonly catalog: CatalogStore;
  readonly copilot: Copilot;
  readonly hub: RealtimeHub;
  readonly limiters: {
    readonly signIn: RateLimiter;
    readonly register: RateLimiter;
    readonly copilot: RateLimiter;
    readonly heavy: RateLimiter;
    readonly write: RateLimiter;
  };
}

export class RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly respond: Responder;
  readonly services: Services;
  readonly config: Config;
  readonly clientId: string;
  readonly clientKey: string;
  readonly sessionToken: string | null;
  user: UserRecord | null = null;

  private readonly cookies: string[];

  constructor(options: {
    req: IncomingMessage; res: ServerResponse; url: URL; services: Services;
    cookies: string[]; baseHeaders: Record<string, string>; clientKey: string;
  }) {
    this.req = options.req;
    this.res = options.res;
    this.url = options.url;
    this.services = options.services;
    this.config = options.services.config;
    this.cookies = options.cookies;
    this.respond = responder(options.res, options.baseHeaders, options.cookies);
    this.clientKey = options.clientKey;
    this.sessionToken = readSessionCookie(options.req);
    // Identifies the originating browser tab so its own edits are not echoed back to it over SSE.
    this.clientId = String(options.req.headers['x-client-id'] ?? '').slice(0, 64);
  }

  body<T = unknown>(maxBytes = this.config.limits.jsonBodyBytes): Promise<T> {
    return readJson<T>(this.req, maxBytes);
  }

  requireUser(): UserRecord {
    if (this.user === null) throw unauthenticated();
    return this.user;
  }

  setCookie(value: string): void {
    this.cookies.push(value);
  }

  /**
   * Resolve the workspace this request targets and check the caller's access.
   *
   * The id comes from the `x-workspace` header for fetch calls, or `?workspace=` for the download
   * and streaming endpoints that browsers open without custom headers. Either way the id is only a
   * *claim* — `accounts.access` decides whether it is honoured.
   */
  workspaceAccess(): WorkspaceAccess {
    const user = this.requireUser();
    const requested = String(this.req.headers['x-workspace'] ?? this.url.searchParams.get('workspace') ?? '').trim();
    if (requested.length === 0) {
      const workspace = this.services.accounts.defaultWorkspace(user.id);
      return { workspace, role: 'owner' };
    }
    return this.services.accounts.access(user.id, requested);
  }

  async document(): Promise<{ access: WorkspaceAccess; doc: WorkspaceDocument }> {
    const access = this.workspaceAccess();
    const doc = await this.services.documents.get(access.workspace.id);
    return { access, doc };
  }

  /**
   * Serialise, push to collaborators, and answer the caller — the tail of every mutating route.
   * `extra` carries a per-operation note (how many runs an auto-route added, for instance) that the
   * UI shows; collaborators receive the state without it, since the note describes someone else's
   * action.
   */
  commit(doc: WorkspaceDocument, extra?: Record<string, unknown>): StateSnapshot {
    doc.touch();
    const state = serializeDocument(doc);
    this.services.hub.publish(doc.workspaceId, this.clientId, state);
    this.respond.json(extra === undefined ? state : { ...state, ...extra });
    return state;
  }
}

export function buildRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerWorkspaceRoutes(router);
  registerDesignRoutes(router);
  registerLibraryRoutes(router);
  registerExportRoutes(router);

  router.get('/api/health', (ctx) => {
    ctx.respond.json({
      status: 'ok',
      version: '0.1.0',
      jurisdictions: Object.keys(JURISDICTIONS),
      ai: ctx.config.ai.enabled,
      authMode: ctx.config.authMode,
    });
  }, { anonymous: true });

  return router;
}

export function createRequestHandler(services: Services, router: Router) {
  const { config } = services;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const secure = config.behindTlsProxy || (req.socket as { encrypted?: boolean }).encrypted === true;
    const cookies: string[] = [];
    const baseHeaders = securityHeaders({ secure, scriptSources: services.inlineScriptSources });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400, baseHeaders).end('Bad request');
      return;
    }

    const ctx = new RequestContext({
      req, res, url, services, cookies, baseHeaders,
      clientKey: clientKeyFor(req),
    });

    try {
      assertSameOrigin(req, url);

      const method = req.method ?? 'GET';
      const route = router.find(method === 'HEAD' ? 'GET' : method, url.pathname);

      if (route === undefined) {
        if (method === 'GET' && !url.pathname.startsWith('/api/')) {
          await serveStatic(req, ctx.respond, config.publicDir, url.pathname);
          return;
        }
        throw notFound();
      }

      if (!route.anonymous) {
        await authenticate(ctx);
        if (method !== 'GET') services.limiters.write.check(ctx.user?.id ?? ctx.clientKey);
      }

      await route.handler(ctx);
    } catch (err) {
      respondWithError(ctx, err, secure);
    }
  };
}

/**
 * Attach the signed-in user, or throw 401.
 *
 * In `open` mode the server is a single-user local tool: it binds to loopback, has no sign-in, and
 * every request runs as the same local account. The mode refuses to start on a routable host, so
 * this branch can never be reached by a remote client.
 */
async function authenticate(ctx: RequestContext): Promise<void> {
  if (ctx.config.authMode === 'open') {
    ctx.user = await localUser(ctx.services);
    return;
  }
  const session = ctx.services.sessions.lookup(ctx.sessionToken);
  if (session === null) throw unauthenticated();
  const user = ctx.services.accounts.getUser(session.userId);
  if (user === undefined) {
    // The account was removed while the session was live.
    await ctx.services.sessions.destroy(ctx.sessionToken);
    ctx.setCookie(clearedSessionCookie(ctx.config.behindTlsProxy));
    throw unauthenticated();
  }
  ctx.user = user;
}

const LOCAL_USERNAME = 'local';
let localUserPromise: Promise<UserRecord> | null = null;

function localUser(services: Services): Promise<UserRecord> {
  localUserPromise ??= (async () => {
    const existing = services.accounts.findByUsername(LOCAL_USERNAME);
    if (existing !== undefined) return existing;
    // The password is never used: `open` mode has no sign-in route.
    return services.accounts.register(LOCAL_USERNAME, `local-only-${Date.now()}-${Math.random()}`);
  })();
  return localUserPromise;
}

/**
 * Reject cross-site state-changing requests.
 *
 * Session cookies are already `SameSite=Strict`, so a cross-site browser request arrives without
 * credentials and fails authentication anyway. This is the second lock: it also covers clients that
 * ignore SameSite, and it is skipped when neither `Origin` nor `Sec-Fetch-Site` is present, which
 * is how non-browser callers (curl, CI, an integration) identify themselves.
 */
function assertSameOrigin(req: IncomingMessage, url: URL): void {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string') {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return;
    throw forbidden('Cross-site requests are not accepted');
  }

  const origin = req.headers.origin;
  if (typeof origin !== 'string') return; // not a browser
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden('Malformed Origin header');
  }
  if (originHost !== url.host) throw forbidden('Cross-site requests are not accepted');
}

/** A stable-enough key for rate limiting an anonymous caller. */
function clientKeyFor(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function respondWithError(ctx: RequestContext, err: unknown, secure: boolean): void {
  if (ctx.res.writableEnded || ctx.res.headersSent) return;

  if (err instanceof HttpError) {
    ctx.respond.json({ error: err.message, code: err.code }, err.status, err.headers);
    return;
  }

  // Anything else is a defect. Log it with full detail; tell the client nothing about it.
  console.error(`[error] ${ctx.req.method} ${ctx.url.pathname}`, err);
  void secure;
  ctx.respond.json({ error: 'Something went wrong on the server', code: 'internal_error' }, 500);
}

export { sessionCookie };
