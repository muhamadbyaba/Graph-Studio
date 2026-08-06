import { createHash } from 'node:crypto';

/**
 * Content-Security-Policy construction.
 *
 * The app is a single origin with no third-party scripts, so it can afford a policy that blocks
 * remote code outright. Two inline scripts are still unavoidable: the import map that lets the
 * browser resolve `three` without a bundler, and the print handler in the generated report. Rather
 * than opening `script-src` with `'unsafe-inline'` — which would defeat the point — each is allowed
 * by the SHA-256 of its exact contents. Change a byte and the browser refuses to run it, which is
 * the property that makes hashes worth the extra step.
 */

const BASE_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  // 'wasm-unsafe-eval' is required by the WebAssembly IFC parser; it does not permit JavaScript eval.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  // Inline styles only: the SVG canvas writes `style` attributes while rendering.
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** The CSP source expression for an inline script with exactly this body. */
export function scriptHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

export function buildCsp(extraScriptSources: readonly string[] = []): string {
  return Object.entries(BASE_DIRECTIVES)
    .map(([directive, sources]) => {
      const values = directive === 'script-src' ? [...sources, ...extraScriptSources] : sources;
      return `${directive} ${values.join(' ')}`;
    })
    .join('; ');
}

/**
 * Collect the hashes of every inline `<script>` in a document.
 *
 * Deriving these from the served file means the policy cannot drift out of step with the markup:
 * editing index.html updates the hash on the next start, and no one has to remember to.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const pattern = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (body.trim().length === 0) continue;
    hashes.push(scriptHash(body));
  }
  return [...new Set(hashes)];
}
