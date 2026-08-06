import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Durable JSON files with two properties the naive `writeFile` version does not have.
 *
 * Atomicity: a write goes to a temporary file in the same directory and is then renamed over the
 * target. `rename` within a filesystem is atomic, so a crash or a full disk mid-write leaves the
 * previous version intact instead of a truncated file that fails to parse on the next boot.
 *
 * Serialisation: writes to the same path queue behind each other. Two concurrent requests saving
 * the same document would otherwise interleave their temp files and the later rename would silently
 * win with stale content.
 */
const inFlight = new Map<string, Promise<void>>();

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const previous = inFlight.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeAtomic(path, value));
  inFlight.set(path, next);
  try {
    await next;
  } finally {
    if (inFlight.get(path) === next) inFlight.delete(path);
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  } catch (err) {
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}
