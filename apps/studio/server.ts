/**
 * BuildGraph Studio — server entry point.
 *
 * Runs on Node's native TypeScript, so there is no build step: `node server.ts` is the whole
 * command. The process has no runtime dependencies of its own; everything it needs comes from the
 * standard library and the workspace's engineering core.
 *
 * This file does three things and nothing else: construct the services, start the HTTP server with
 * timeouts that survive contact with the open internet, and shut down without losing work.
 */
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JURISDICTIONS } from '@buildgraph/engineering-core';
import { loadConfig } from './src/config.ts';
import { AccountStore } from './src/auth/accounts.ts';
import { SessionStore } from './src/auth/sessions.ts';
import { DocumentRegistry } from './src/model/documents.ts';
import { RealtimeHub } from './src/realtime/hub.ts';
import { CatalogStore } from './src/storage/catalog.ts';
import { ProjectStore } from './src/storage/projects.ts';
import { Copilot } from './src/copilot/copilot.ts';
import { RateLimiter } from './src/http/rate-limit.ts';
import { inlineScriptHashes } from './src/http/csp.ts';
import { buildRouter, createRequestHandler } from './src/app.ts';
import type { Services } from './src/app.ts';

const config = loadConfig();

await mkdir(config.dataDir, { recursive: true, mode: 0o700 });

const hub = new RealtimeHub({ maxClientsPerRoom: config.limits.sseClientsPerWorkspace });

// The app shell contains one inline script — the import map that lets the browser resolve bare
// module specifiers without a bundler. Hashing it here keeps `script-src` free of 'unsafe-inline'.
const shell = await readFile(join(config.publicDir, 'index.html'), 'utf8').catch(() => '');
const inlineScriptSources = inlineScriptHashes(shell);

const services: Services = {
  config,
  inlineScriptSources,
  accounts: await AccountStore.open(config.dataDir),
  sessions: await SessionStore.open(config.dataDir, config.sessionTtlMs),
  documents: new DocumentRegistry(config, JURISDICTIONS, (workspaceId) => hub.hasSubscribers(workspaceId)),
  projects: new ProjectStore(config.dataDir, config.limits.projectsPerWorkspace),
  catalog: await CatalogStore.open(config.dataDir, config.limits.customCatalogItems),
  copilot: new Copilot(config),
  hub,
  limiters: {
    signIn: new RateLimiter({ limit: 10, windowMs: 5 * 60_000, label: 'sign-in' }),
    register: new RateLimiter({ limit: 5, windowMs: 60 * 60_000, label: 'registration' }),
    copilot: new RateLimiter({ limit: 30, windowMs: 5 * 60_000, label: 'assistant' }),
    heavy: new RateLimiter({ limit: 30, windowMs: 5 * 60_000, label: 'model import' }),
    write: new RateLimiter({ limit: 600, windowMs: 60_000, label: 'edit' }),
  },
};

const server = createServer(createRequestHandler(services, buildRouter()));

// Defaults that matter once the port is reachable from anywhere: a client must finish its headers
// promptly, an idle socket is reclaimed, and a request cannot hold a connection open indefinitely.
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 65_000;
server.maxHeadersCount = 100;

server.listen(config.port, config.host, () => {
  const scheme = config.behindTlsProxy ? 'https' : 'http';
  console.log(`BuildGraph Studio → ${scheme}://${config.host}:${config.port}`);
  console.log(`  mode         ${config.production ? 'production' : 'development'} · auth ${config.authMode}`);
  console.log(`  data         ${config.dataDir}`);
  console.log(`  jurisdictions ${Object.keys(JURISDICTIONS).join(', ')}`);
  console.log(`  copilot      ${config.ai.enabled ? `live (${config.ai.model})` : 'deterministic engine (set ANTHROPIC_API_KEY for the live assistant)'}`);
  if (config.authMode === 'open') {
    console.log('  note         running without authentication on loopback — do not expose this port');
  }
});

/**
 * Shut down cleanly: stop accepting connections, close the live streams so browsers reconnect
 * rather than hang, and flush every document that has unsaved edits before the process exits.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — finishing in-flight work…`);

  const forced = setTimeout(() => {
    console.error('shutdown timed out — exiting');
    process.exit(1);
  }, 10_000);
  forced.unref();

  hub.close();
  server.close();
  await services.documents.closeAll();
  await services.sessions.close();

  clearTimeout(forced);
  console.log('stopped.');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
});
