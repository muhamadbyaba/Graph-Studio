import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Responder } from './respond.ts';
import { notFound } from './errors.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * Serve a file from the public directory.
 *
 * Two things are deliberate. First, containment: the request path is percent-decoded *before* it is
 * resolved, then the resolved absolute path is checked to be inside the public root by path
 * relationship rather than by string prefix — `/public-backup/secrets` must not pass a
 * `startsWith('/public')` test. Second, caching by content: every response carries a strong ETag of
 * the bytes, so the browser revalidates cheaply and never runs a stale bundle after a deploy, while
 * immutable third-party assets under /vendor are allowed to sit in cache for a year.
 */
export async function serveStatic(req: IncomingMessage, respond: Responder, publicDir: string, urlPath: string): Promise<void> {
  const filePath = resolveWithin(publicDir, urlPath);
  if (filePath === null) throw notFound();

  let bytes: Buffer;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw notFound();
    bytes = await readFile(filePath);
  } catch {
    throw notFound();
  }

  const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`;
  const immutable = urlPath.startsWith('/vendor/');
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';

  if (req.headers['if-none-match'] === etag) {
    respond.raw(Buffer.alloc(0), CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream', 304, { etag, 'cache-control': cacheControl });
    return;
  }

  respond.raw(bytes, CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream', 200, { etag, 'cache-control': cacheControl });
}

/**
 * Map a URL path to an absolute path guaranteed to be inside `root`, or null if it escapes.
 * Returns null for dotfiles so that stray `.env` or `.git` material can never be served.
 */
export function resolveWithin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = resolve(join(root, relativePath));
  const rootAbs = resolve(root);
  const rel = relative(rootAbs, target);
  if (rel === '' || rel.startsWith('..') || rel.split(sep).some((part) => part.startsWith('.'))) return null;
  return target;
}
