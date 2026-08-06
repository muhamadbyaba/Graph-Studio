import type { RequestContext, Router } from '../app.ts';
import { clearedSessionCookie, sessionCookie } from '../auth/sessions.ts';
import { badRequest, forbidden, unauthenticated } from '../http/errors.ts';

/**
 * Sign-up, sign-in, sign-out and the current-identity endpoint.
 *
 * Sign-in is rate limited per address *and* per username, so neither spraying one password across
 * many accounts nor hammering one account is cheap. A wrong password and an unknown username return
 * the same message after the same amount of work, so the endpoint cannot be used to enumerate who
 * has an account here.
 */
export function registerAuthRoutes(router: Router): void {
  router.get('/api/auth/me', (ctx) => {
    if (ctx.config.authMode === 'open') {
      ctx.respond.json({ authMode: 'open', user: { username: 'local', displayName: 'Local' }, allowRegistration: false });
      return;
    }
    const session = ctx.services.sessions.lookup(ctx.sessionToken);
    const user = session === null ? undefined : ctx.services.accounts.getUser(session.userId);
    ctx.respond.json({
      authMode: 'accounts',
      allowRegistration: ctx.config.allowRegistration,
      user: user === undefined ? null : { id: user.id, username: user.username, displayName: user.displayName },
    });
  }, { anonymous: true });

  router.post('/api/auth/register', async (ctx) => {
    if (ctx.config.authMode === 'open') throw badRequest('Registration is disabled in local mode');
    if (!ctx.config.allowRegistration) throw forbidden('Registration is closed on this server');
    ctx.services.limiters.register.check(ctx.clientKey);

    const body = await ctx.body<{ username?: unknown; password?: unknown }>(4096);
    const user = await ctx.services.accounts.register(String(body.username ?? ''), String(body.password ?? ''));
    await startSession(ctx, user.id);

    ctx.respond.json({ user: { id: user.id, username: user.username, displayName: user.displayName } }, 201);
  }, { anonymous: true });

  router.post('/api/auth/login', async (ctx) => {
    if (ctx.config.authMode === 'open') throw badRequest('Sign-in is not used in local mode');

    const body = await ctx.body<{ username?: unknown; password?: unknown }>(4096);
    const username = String(body.username ?? '').trim().toLowerCase().slice(0, 64);

    ctx.services.limiters.signIn.check(ctx.clientKey);
    if (username.length > 0) ctx.services.limiters.signIn.check(`user:${username}`);

    const user = await ctx.services.accounts.authenticate(username, String(body.password ?? ''));
    if (user === null) throw unauthenticated('Incorrect username or password');

    ctx.services.limiters.signIn.clear(ctx.clientKey);
    ctx.services.limiters.signIn.clear(`user:${username}`);
    await startSession(ctx, user.id);

    ctx.respond.json({ user: { id: user.id, username: user.username, displayName: user.displayName } });
  }, { anonymous: true });

  router.post('/api/auth/logout', async (ctx) => {
    await ctx.services.sessions.destroy(ctx.sessionToken);
    ctx.setCookie(clearedSessionCookie(isSecure(ctx)));
    ctx.respond.json({ ok: true });
  }, { anonymous: true });

  router.post('/api/auth/password', async (ctx) => {
    if (ctx.config.authMode === 'open') throw badRequest('Passwords are not used in local mode');
    const user = ctx.requireUser();
    const body = await ctx.body<{ currentPassword?: unknown; newPassword?: unknown }>(4096);

    await ctx.services.accounts.changePassword(user.id, String(body.currentPassword ?? ''), String(body.newPassword ?? ''));
    // Every other session belonging to this account is invalidated; the current one is reissued.
    await ctx.services.sessions.destroyAllFor(user.id);
    await startSession(ctx, user.id);

    ctx.respond.json({ ok: true });
  });
}

async function startSession(ctx: RequestContext, userId: string): Promise<void> {
  const { token } = await ctx.services.sessions.create(userId);
  ctx.setCookie(sessionCookie(token, {
    secure: isSecure(ctx),
    maxAgeSeconds: Math.floor(ctx.config.sessionTtlMs / 1000),
  }));
}

function isSecure(ctx: RequestContext): boolean {
  return ctx.config.behindTlsProxy || (ctx.req.socket as { encrypted?: boolean }).encrypted === true;
}
