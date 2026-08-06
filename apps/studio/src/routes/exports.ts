import type { Router } from '../app.ts';
import { serializeDocument } from '../model/serialize.ts';
import { REPORT_SCRIPT, buildReportHtml } from '../report/html.ts';
import { buildCsp, scriptHash } from '../http/csp.ts';
import { buildBoqCsv } from '../report/csv.ts';

/**
 * Document deliverables: the design report and the Bill of Quantities export.
 *
 * Both are opened by the browser as top-level navigations rather than fetches, so they cannot carry
 * an `x-workspace` header and take `?workspace=` instead. The session cookie still travels with the
 * navigation, so authorisation is unchanged — the query parameter names a workspace, it does not
 * grant one.
 */
export function registerExportRoutes(router: Router): void {
  router.get('/api/report', async (ctx) => {
    const { access, doc } = await ctx.document();
    const html = buildReportHtml(serializeDocument(doc), access.workspace.name);
    // The report carries its own policy: the same strict baseline plus the hash of its print script.
    ctx.respond.html(html, 200, { 'content-security-policy': buildCsp([scriptHash(REPORT_SCRIPT)]) });
  });

  router.get('/api/boq.csv', async (ctx) => {
    const { doc } = await ctx.document();
    const csv = buildBoqCsv(serializeDocument(doc));
    // A BOM so Excel opens UTF-8 correctly; `attachment` so the file is never rendered inline.
    ctx.respond.text(`﻿${csv}`, 'text/csv; charset=utf-8', 200, {
      'content-disposition': 'attachment; filename="buildgraph-boq.csv"',
    });
  });
}
