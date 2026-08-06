import type { RequestContext, Router } from '../app.ts';
import { cleanWorkspaceName } from '../auth/accounts.ts';
import { badRequest } from '../http/errors.ts';

/**
 * Workspace management and the live-collaboration stream.
 *
 * A workspace is the access-control boundary: it owns a drawing, its saved projects and its
 * component library. Membership is explicit and only the owner can grant it, so collaboration is
 * always something someone chose rather than something a guessed name unlocked.
 */
export function registerWorkspaceRoutes(router: Router): void {
  router.get('/api/workspaces', (ctx) => {
    const user = ctx.requireUser();
    const list = ctx.services.accounts.listWorkspaces(user.id);
    ctx.respond.json({
      workspaces: list.map(({ workspace }) => ctx.services.accounts.describe(workspace, user.id)),
      active: ctx.workspaceAccess().workspace.id,
    });
  });

  router.post('/api/workspaces', async (ctx) => {
    const user = ctx.requireUser();
    const body = await ctx.body<{ name?: unknown }>(4096);
    const workspace = await ctx.services.accounts.createWorkspace(user.id, cleanWorkspaceName(body.name));
    ctx.respond.json(ctx.services.accounts.describe(workspace, user.id), 201);
  });

  router.post('/api/workspace/rename', async (ctx) => {
    const user = ctx.requireUser();
    const body = await ctx.body<{ name?: unknown }>(4096);
    const { workspace } = ctx.workspaceAccess();
    const renamed = await ctx.services.accounts.renameWorkspace(user.id, workspace.id, cleanWorkspaceName(body.name));
    ctx.respond.json(ctx.services.accounts.describe(renamed, user.id));
  });

  router.post('/api/workspace/members', async (ctx) => {
    const user = ctx.requireUser();
    const body = await ctx.body<{ username?: unknown }>(4096);
    const { workspace } = ctx.workspaceAccess();
    const updated = await ctx.services.accounts.addMember(user.id, workspace.id, String(body.username ?? ''));
    ctx.respond.json(ctx.services.accounts.describe(updated, user.id));
  });

  router.post('/api/workspace/members/remove', async (ctx) => {
    const user = ctx.requireUser();
    const body = await ctx.body<{ userId?: unknown }>(4096);
    const memberId = String(body.userId ?? '');
    if (memberId.length === 0) throw badRequest('A collaborator id is required');

    const { workspace } = ctx.workspaceAccess();
    const updated = await ctx.services.accounts.removeMember(user.id, workspace.id, memberId);
    // Close any live stream the removed collaborator still holds open.
    ctx.services.hub.evict(workspace.id, memberId);
    ctx.respond.json(ctx.services.accounts.describe(updated, user.id));
  });

  /**
   * The live stream. `EventSource` cannot set request headers, so the workspace arrives as a query
   * parameter and the session as the cookie the browser sends automatically — the id is still only
   * a claim, checked by `workspaceAccess()` exactly as it is for every other route.
   */
  router.get('/api/events', (ctx: RequestContext) => {
    const user = ctx.requireUser();
    const { workspace } = ctx.workspaceAccess();
    const clientId = String(ctx.url.searchParams.get('client') ?? ctx.clientId).slice(0, 64);

    ctx.services.hub.subscribe(
      workspace.id,
      { res: ctx.res, clientId, userId: user.id },
      { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
    );
  });
}
