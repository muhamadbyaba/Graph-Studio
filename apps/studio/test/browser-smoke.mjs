#!/usr/bin/env node
/**
 * Browser smoke test: drive the real UI in headless Chrome over the DevTools Protocol.
 *
 * This exists because the rest of the suite cannot see the browser. A typecheck, 245 unit and
 * integration tests, and a server boot check all passed while the 3D view was completely broken —
 * three.js split its ESM build across two files, only one was being copied, and the module graph
 * failed at load time in the browser and nowhere else. Anything that only fails once a real page
 * loads needs a real page to catch it.
 *
 * Deliberately dependency-free: Chrome is driven over a WebSocket using Node's built-in client,
 * so there is no Puppeteer or Playwright to install, and the check runs anywhere Chrome exists.
 *
 *   node apps/studio/test/browser-smoke.mjs
 *   BASE=http://127.0.0.1:4317 CHROME=/path/to/chrome node apps/studio/test/browser-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4317';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9222);

/** Chrome lives in a different place on every platform and CI image. */
const CHROME_CANDIDATES = [
  process.env.CHROME,
  process.env.CHROME_PATH,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(name, passed, detail = '') {
  checks.push({ name, passed });
  console.log(`${passed ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ chrome */

async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'buildgraph-smoke-'));
  const args = [
    '--headless=new',
    // Software WebGL: CI runners have no GPU, and the 3D view must still initialise.
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1000', 'about:blank',
  ];

  for (const binary of CHROME_CANDIDATES) {
    const child = spawn(binary, args, { stdio: 'ignore' });
    const failed = await new Promise((resolve) => {
      child.once('error', () => resolve(true));
      setTimeout(() => resolve(false), 600);
    });
    if (!failed) return { child, profile };
    child.kill();
  }
  throw new Error(`no Chrome found — tried: ${CHROME_CANDIDATES.join(', ')}`);
}

async function debuggerUrl() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await sleep(400);
  }
  throw new Error('Chrome never exposed a debugging endpoint');
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];
  let nextId = 1;

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description ?? details.text);
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  return { socket, send, evaluate, consoleErrors, pageErrors };
}

/* ------------------------------------------------------------------- checks */

async function run(page) {
  const { send, evaluate, consoleErrors, pageErrors } = page;
  await send('Runtime.enable');
  await send('Page.enable');

  await send('Page.navigate', { url: BASE });
  await sleep(2500);

  check('the sign-in gate blocks an anonymous visitor',
    await evaluate(`!document.getElementById('authGate').hidden`));

  const username = `smoke${Date.now().toString(36).slice(-6)}`;
  await evaluate(`
    document.getElementById('tabRegister').click();
    document.getElementById('authUser').value = ${JSON.stringify(username)};
    document.getElementById('authPass').value = 'browser-smoke-test-secret';
    document.getElementById('authForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    true;`);
  await sleep(3000);

  check('registering signs the visitor in', await evaluate(`document.getElementById('authGate').hidden`));
  check('the seed model renders on the canvas',
    (await evaluate(`document.querySelectorAll('#canvas .node').length`)) >= 2);
  check('pipes carry a computed size label',
    await evaluate(`document.querySelectorAll('#canvas .pipe-label').length > 0`));
  check('the bill of quantities is priced',
    await evaluate(`/\\d/.test(document.getElementById('boq').textContent)`));
  check('the hydraulic solver reports a critical outlet',
    await evaluate(`document.getElementById('hydraulics').textContent.includes('Critical outlet')`));

  // Placing from the palette exercises the event round-trip through the engine.
  await evaluate(`
    document.querySelector('.chip[data-type="Shower"]').click();
    const svg = document.getElementById('canvas');
    const box = svg.getBoundingClientRect();
    svg.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: box.left + box.width * 0.7, clientY: box.top + box.height * 0.6, bubbles: true,
    }));
    true;`);
  await sleep(1500);
  check('placing a fixture from the palette adds it to the model',
    (await evaluate(`document.querySelectorAll('#canvas .node').length`)) >= 3);

  await evaluate(`document.querySelector('[data-view="cad"]').click(); true;`);
  await sleep(900);
  check('the CAD view draws double-line pipework',
    await evaluate(`document.querySelectorAll('#canvas .pcad-edge').length > 0`));

  // The check this file was written for: the 3D module graph must actually load.
  await evaluate(`document.querySelector('[data-view="3d"]').click(); true;`);
  await sleep(6000);
  check('the 3D view mounts a WebGL canvas',
    await evaluate(`!!document.querySelector('#view3d canvas')`),
    await evaluate(`document.getElementById('status').textContent`));

  await evaluate(`document.querySelector('[data-view="schematic"]').click(); true;`);
  await sleep(600);

  await evaluate(`document.getElementById('pressure').click(); true;`);
  await sleep(1200);
  check('the pressure map tags outlets with their residual',
    await evaluate(`document.querySelectorAll('#canvas .pchip').length > 0`));

  await evaluate(`document.getElementById('library').click(); true;`);
  await sleep(1500);
  check('the component library loads',
    /\d+ of \d+/.test(await evaluate(`document.getElementById('libCount').textContent`)));
  await evaluate(`document.getElementById('libClose').click(); true;`);

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  check('no uncaught exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
}

/* --------------------------------------------------------------------- main */

let chrome = null;
let profile = null;
let page = null;
try {
  ({ child: chrome, profile } = await launchChrome());
  page = connect(await debuggerUrl());
  await new Promise((resolve, reject) => { page.socket.onopen = resolve; page.socket.onerror = reject; });
  await run(page);
} catch (err) {
  console.error(`\nbrowser smoke test could not complete: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  page?.socket.close();
  chrome?.kill();
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}

const failed = checks.filter((c) => !c.passed);
console.log(`\n${checks.length - failed.length}/${checks.length} browser checks passed`);
if (failed.length > 0) process.exitCode = 1;
