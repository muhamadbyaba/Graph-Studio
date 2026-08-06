/**
 * A failure with an HTTP status and a message that is safe to show a client.
 *
 * Anything thrown that is *not* an `HttpError` is treated as a bug: it is logged in full on the
 * server and reported to the client as a bare 500. That split keeps internal detail — file system
 * paths, stack traces, upstream API responses — out of responses without having to remember to
 * sanitise at every throw site.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, message: string, options: { code?: string; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code ?? defaultCode(status);
    this.headers = options.headers ?? {};
  }
}

function defaultCode(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthenticated';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 413: return 'payload_too_large';
    case 429: return 'rate_limited';
    case 503: return 'unavailable';
    default: return 'error';
  }
}

export const badRequest = (message: string, code?: string): HttpError => new HttpError(400, message, { code });
export const unauthenticated = (message = 'Sign in to continue'): HttpError => new HttpError(401, message);
export const forbidden = (message = 'You do not have access to this workspace'): HttpError => new HttpError(403, message);
export const notFound = (message = 'Not found'): HttpError => new HttpError(404, message);
export const conflict = (message: string): HttpError => new HttpError(409, message);
export const tooLarge = (message: string): HttpError => new HttpError(413, message);
export const tooManyRequests = (message: string, retryAfterSeconds: number): HttpError =>
  new HttpError(429, message, { headers: { 'retry-after': String(retryAfterSeconds) } });
