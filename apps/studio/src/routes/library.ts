import type { Router } from '../app.ts';
import { cleanProjectName } from '../storage/projects.ts';
import { validateEvents } from '../model/validate-events.ts';
import { badRequest } from '../http/errors.ts';

/** The component library and saved projects — both scoped to the caller's workspace. */
export function registerLibraryRoutes(router: Router): void {
  router.get('/api/catalog', (ctx) => {
    const { workspace } = ctx.workspaceAccess();
    ctx.respond.json(ctx.services.catalog.query(workspace.id, {
      discipline: ctx.url.searchParams.get('discipline')?.slice(0, 40) ?? undefined,
      query: ctx.url.searchParams.get('q')?.slice(0, 80) ?? undefined,
    }));
  });

  router.post('/api/catalog', async (ctx) => {
    const { workspace } = ctx.workspaceAccess();
    const body = await ctx.body<unknown>(16_384);
    ctx.respond.json(await ctx.services.catalog.add(workspace.id, body), 201);
  });

  router.get('/api/projects', async (ctx) => {
    const { workspace } = ctx.workspaceAccess();
    ctx.respond.json({
      projects: await ctx.services.projects.list(workspace.id),
      workspace: { id: workspace.id, name: workspace.name },
    });
  });

  router.post('/api/project/save', async (ctx) => {
    const body = await ctx.body<{ name?: unknown }>(4096);
    const { access, doc } = await ctx.document();

    const summary = await ctx.services.projects.save(access.workspace.id, cleanProjectName(body.name), {
      jurisdiction: doc.pack.id,
      meta: doc.meta,
      events: [...doc.history.log()],
    });
    ctx.respond.json(summary);
  });

  router.post('/api/project/load', async (ctx) => {
    const body = await ctx.body<{ name?: unknown }>(4096);
    const { access, doc } = await ctx.document();

    const saved = await ctx.services.projects.load(access.workspace.id, cleanProjectName(body.name));
    // A saved file is untrusted input like any other request body: it may have been hand-edited, or
    // written by an older version whose event shapes have since changed.
    const events = validateEvents(saved.events, ctx.config.limits.eventsPerDocument);

    doc.replaceAll(events);
    doc.meta = saved.meta ?? {};
    ctx.commit(doc);
  });

  router.post('/api/project/delete', async (ctx) => {
    const body = await ctx.body<{ name?: unknown }>(4096);
    const { workspace } = ctx.workspaceAccess();
    await ctx.services.projects.remove(workspace.id, cleanProjectName(body.name));
    ctx.respond.json({ ok: true });
  });

  router.get('/api/export', async (ctx) => {
    const { doc } = await ctx.document();
    ctx.respond.json({ version: 1, jurisdiction: doc.pack.id, meta: doc.meta, events: [...doc.history.log()] });
  });

  router.post('/api/import', async (ctx) => {
    const body = await ctx.body<{ events?: unknown }>();
    if (!Array.isArray(body.events)) throw badRequest('Expected { "events": [...] }');
    const events = validateEvents(body.events, ctx.config.limits.eventsPerDocument);

    const { doc } = await ctx.document();
    doc.replaceAll(events);
    ctx.commit(doc);
  });
}
