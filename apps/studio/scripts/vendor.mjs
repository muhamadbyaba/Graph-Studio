#!/usr/bin/env node
/**
 * Copy the browser-side third-party assets out of node_modules into public/vendor.
 *
 * The UI has no bundler by design: index.html declares an import map and the browser loads ES
 * modules directly. That means three.js and the web-ifc WebAssembly parser have to be reachable
 * under the public root. Copying them at install time keeps them out of version control while
 * preserving the "clone, install, run" path — and keeps the versions pinned by package-lock.json
 * as the single source of truth instead of a hand-updated checked-in copy.
 *
 * Run automatically on `npm install`; run manually with `npm run vendor`.
 */
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(appRoot, 'public', 'vendor');

/**
 * `optional: true` marks an asset that only some versions of a package ship. three.js split its
 * ESM build in r16x: `three.module.js` became a thin entry that does `import … from
 * './three.core.js'`, so copying the entry alone leaves the browser requesting a file that is not
 * there. The failure is silent to a typecheck and to the test suite — the module graph only breaks
 * when a browser actually loads the 3D view — so the copy has to cover both layouts.
 */
const ASSETS = [
  { from: ['three', 'build/three.module.js'], to: 'three.module.js' },
  { from: ['three', 'build/three.core.js'], to: 'three.core.js', optional: true },
  { from: ['three', 'examples/jsm/controls/OrbitControls.js'], to: 'OrbitControls.js' },
  { from: ['web-ifc', 'web-ifc-api.js'], to: 'web-ifc/web-ifc-api.js' },
  { from: ['web-ifc', 'web-ifc.wasm'], to: 'web-ifc/web-ifc.wasm' },
];

/**
 * Walk up from the app looking for the package directory in each node_modules on the way, which is
 * how npm hoisting lays out a workspace. `require.resolve` is not usable here: both packages
 * declare an `exports` map that refuses deep paths, and the wasm binary is not exported at all.
 */
async function resolveAsset(packageName, subpath) {
  let dir = appRoot;
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName, subpath);
    try {
      await stat(candidate);
      return candidate;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return null;
    dir = parent;
  }
}

async function main() {
  const clean = process.argv.includes('--clean');
  if (clean) await rm(vendorDir, { recursive: true, force: true });

  const copied = [];
  const missing = [];

  for (const asset of ASSETS) {
    const [packageName, subpath] = asset.from;
    const source = await resolveAsset(packageName, subpath);
    if (source === null) {
      if (!asset.optional) missing.push(`${packageName}/${subpath}`);
      continue;
    }
    const target = join(vendorDir, asset.to);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    copied.push(asset.to);
  }

  // A vendored ES module that imports a sibling which was not copied produces a 404 at load time
  // and nothing earlier. Resolve those references now, while it is still cheap to notice.
  const unresolved = await findUnresolvedImports(copied);
  if (unresolved.length > 0) {
    console.error('vendor: a copied module imports a file that was not copied:');
    for (const { file, specifier } of unresolved) console.error(`  ${file} imports ${specifier}`);
    console.error('  add it to ASSETS in this script, or the browser will fail to load the module.');
    process.exitCode = 1;
    return;
  }

  if (missing.length > 0) {
    // Not fatal: `npm install --ignore-scripts` or a partial install should not break the tree.
    console.warn(`vendor: skipped ${missing.length} asset(s) — run "npm install" then "npm run vendor".`);
    for (const name of missing) console.warn(`  missing: ${name}`);
  }
  if (copied.length > 0) console.log(`vendor: ${copied.length} asset(s) → public/vendor`);
}

/**
 * Check every copied JavaScript file for relative imports whose target is not also present.
 * Static analysis is enough here: these are published build artefacts, not dynamic code.
 */
async function findUnresolvedImports(copied) {
  const problems = [];
  for (const name of copied) {
    if (!name.endsWith('.js') && !name.endsWith('.mjs')) continue;
    const path = join(vendorDir, name);
    const source = await readFile(path, 'utf8');
    // Matched on the `from` (or dynamic `import(`) rather than by pairing it with a preceding
    // `import` keyword: a bundled module's named-import list runs to thousands of characters, so
    // any bounded gap between the two is a bound that will eventually be too small.
    const specifiers = new Set(
      [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]*)['"]/g)].map((m) => m[1]),
    );
    for (const specifier of specifiers) {
      const target = resolve(dirname(path), specifier);
      try {
        await stat(target);
      } catch {
        problems.push({ file: name, specifier });
      }
    }
  }
  return problems;
}

main().catch((err) => {
  console.error('vendor: failed —', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
