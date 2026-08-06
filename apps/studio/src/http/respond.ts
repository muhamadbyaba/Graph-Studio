import type { ServerResponse } from 'node:http';
import { buildCsp } from './csp.ts';

/**
 * Response helpers and the baseline security headers.
 *
 * Every response carries the same hardening set: a strict Content-Security-Policy, MIME sniffing
 * off, framing denied, no referrer leakage, and a permissions policy that turns off device APIs the
 * app never asks for. Applying them centrally means a new route cannot forget them.
 */
export function securityHeaders(options: { secure: boolean; scriptSources?: readonly string[] }): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': buildCsp(options.scriptSources ?? []),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
  };
  if (options.secure) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

export interface Responder {
  json(body: unknown, status?: number, extra?: Record<string, string>): void;
  html(body: string, status?: number, extra?: Record<string, string>): void;
  text(body: string, contentType: string, status?: number, extra?: Record<string, string>): void;
  raw(body: Buffer, contentType: string, status?: number, extra?: Record<string, string>): void;
  /** The underlying response, for handlers that take it over (Server-Sent Events). */
  readonly res: ServerResponse;
}

export function responder(res: ServerResponse, baseHeaders: Record<string, string>, cookies: string[]): Responder {
  const send = (status: number, contentType: string, body: string | Buffer, extra: Record<string, string> = {}): void => {
    if (res.writableEnded) return;
    const headers: Record<string, string | string[]> = {
      ...baseHeaders,
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(body)),
      ...extra,
    };
    if (cookies.length > 0) headers['set-cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(body);
  };
  return {
    res,
    json: (body, status = 200, extra) => send(status, 'application/json; charset=utf-8', JSON.stringify(body), { 'cache-control': 'no-store', ...extra }),
    html: (body, status = 200, extra) => send(status, 'text/html; charset=utf-8', body, { 'cache-control': 'no-store', ...extra }),
    text: (body, contentType, status = 200, extra) => send(status, contentType, body, { 'cache-control': 'no-store', ...extra }),
    raw: (body, contentType, status = 200, extra) => send(status, contentType, body, extra),
  };
}
