import type { ServerResponse } from 'node:http';
import { HttpError } from '../http/errors.ts';

/**
 * Server-Sent Events fan-out for live collaboration.
 *
 * Each workspace is a room; every accepted edit pushes the new state to everyone watching it except
 * the tab that made the edit, which already has it. SSE rather than WebSockets because it is one
 * long-lived HTTP response — no upgrade handshake, no framing library, no runtime dependency — and
 * the traffic here is entirely server-to-client.
 *
 * What this is not: conflict resolution. Two people editing the same element resolve last-write-
 * wins against a shared event log. Operational transforms or a CRDT would be needed for genuinely
 * concurrent editing of the same element, and that is recorded as future work rather than implied.
 */

interface Subscriber {
  readonly res: ServerResponse;
  readonly clientId: string;
  readonly userId: string;
}

export class RealtimeHub {
  private readonly rooms = new Map<string, Set<Subscriber>>();
  private readonly maxPerRoom: number;
  private readonly keepAlive: NodeJS.Timeout;

  constructor(options: { maxClientsPerRoom: number; keepAliveMs?: number }) {
    this.maxPerRoom = options.maxClientsPerRoom;
    this.keepAlive = setInterval(() => this.ping(), options.keepAliveMs ?? 25_000);
    this.keepAlive.unref();
  }

  /** True when anyone is watching — used to keep busy documents resident in memory. */
  hasSubscribers(workspaceId: string): boolean {
    const room = this.rooms.get(workspaceId);
    return room !== undefined && room.size > 0;
  }

  /**
   * Attach a response as a subscriber. The response is taken over: headers are written here and the
   * connection stays open until the client disconnects.
   */
  subscribe(workspaceId: string, subscriber: Subscriber, baseHeaders: Record<string, string>): void {
    let room = this.rooms.get(workspaceId);
    if (room === undefined) {
      room = new Set<Subscriber>();
      this.rooms.set(workspaceId, room);
    }
    if (room.size >= this.maxPerRoom) {
      throw new HttpError(503, 'This workspace already has the maximum number of live connections');
    }

    const { res } = subscriber;
    res.writeHead(200, {
      ...baseHeaders,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Stops a reverse proxy from buffering the stream and delaying every update.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: ready\ndata: ${JSON.stringify({ workspaceId })}\n\n`);

    room.add(subscriber);
    const detach = (): void => {
      const current = this.rooms.get(workspaceId);
      if (current === undefined) return;
      current.delete(subscriber);
      if (current.size === 0) this.rooms.delete(workspaceId); // keep the map from growing forever
    };
    res.on('close', detach);
    res.on('error', detach);
  }

  /** Push a state snapshot to every watcher of a workspace except the tab that produced it. */
  publish(workspaceId: string, originClientId: string, state: unknown): void {
    const room = this.rooms.get(workspaceId);
    if (room === undefined || room.size === 0) return;
    const payload = `data: ${JSON.stringify({ origin: originClientId, state })}\n\n`;
    for (const subscriber of [...room]) {
      if (!write(subscriber.res, payload)) room.delete(subscriber);
    }
  }

  /** Tell every watcher of a workspace that their access has ended (removed as a collaborator). */
  evict(workspaceId: string, userId: string): void {
    const room = this.rooms.get(workspaceId);
    if (room === undefined) return;
    for (const subscriber of [...room]) {
      if (subscriber.userId !== userId) continue;
      write(subscriber.res, `event: revoked\ndata: ${JSON.stringify({ workspaceId })}\n\n`);
      subscriber.res.end();
      room.delete(subscriber);
    }
    if (room.size === 0) this.rooms.delete(workspaceId);
  }

  close(): void {
    clearInterval(this.keepAlive);
    for (const room of this.rooms.values()) for (const subscriber of room) subscriber.res.end();
    this.rooms.clear();
  }

  /** Comment frames keep proxies and load balancers from timing the connection out. */
  private ping(): void {
    for (const [workspaceId, room] of this.rooms) {
      for (const subscriber of [...room]) if (!write(subscriber.res, ': ping\n\n')) room.delete(subscriber);
      if (room.size === 0) this.rooms.delete(workspaceId);
    }
  }
}

function write(res: ServerResponse, payload: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(payload);
    return true;
  } catch {
    return false;
  }
}
