import { join } from 'node:path';
import { GULF_V1, History, foldLayoutEvents } from '@buildgraph/engineering-core';
import type { JurisdictionPack, LayoutEvent, PlumbingLayout } from '@buildgraph/engineering-core';
import { readJsonFile, writeJsonFile } from '../storage/json-file.ts';
import { badRequest } from '../http/errors.ts';
import type { Config } from '../config.ts';

/**
 * The live document for a workspace: its event log, its active jurisdiction and its cover metadata.
 *
 * Documents are held in memory because the reactive model is what makes editing feel instant, but
 * they are not *only* in memory. Every accepted edit schedules a debounced write of the event log,
 * so a restart, a crash or an eviction under memory pressure loses at most a second of work. The
 * registry keeps a bounded number of documents resident and evicts the least recently used, which
 * is what stops an unbounded number of workspaces from being a memory exhaustion vector.
 */

export interface ProjectMeta {
  title?: string;
  client?: string;
  engineer?: string;
  projectNo?: string;
  revision?: string;
}

export const SEED_EVENTS: readonly LayoutEvent[] = Object.freeze([
  { type: 'NodeAdded', id: 'tank', kind: 'source', x: 2, y: 6 },
  { type: 'NodeAdded', id: 'wc', kind: 'fixture', x: 9, y: 4, fixtureType: 'WaterCloset' },
  { type: 'PipeAdded', id: 'p_seed', from: 'tank', to: 'wc', medium: 'cold' },
] as LayoutEvent[]);

interface PersistedDocument {
  version: 1;
  jurisdiction: string;
  meta: ProjectMeta;
  events: LayoutEvent[];
  savedAt: string;
}

export class WorkspaceDocument {
  readonly workspaceId: string;
  readonly history: History<LayoutEvent, PlumbingLayout>;
  meta: ProjectMeta = {};
  lastTouchedAt = Date.now();

  private currentPack: JurisdictionPack = GULF_V1;
  private readonly path: string;
  private readonly maxEvents: number;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  private constructor(workspaceId: string, path: string, maxEvents: number) {
    this.workspaceId = workspaceId;
    this.path = path;
    this.maxEvents = maxEvents;
    // The fold reads `currentPack` at fold time, so switching jurisdiction re-validates the same
    // event log under different code constants without rewriting a single event.
    this.history = new History<LayoutEvent, PlumbingLayout>((events) => foldLayoutEvents(this.currentPack, events));
  }

  static async open(workspaceId: string, config: Config, jurisdictions: Record<string, JurisdictionPack>): Promise<WorkspaceDocument> {
    const path = join(config.dataDir, 'workspaces', `${workspaceId}.json`);
    const doc = new WorkspaceDocument(workspaceId, path, config.limits.eventsPerDocument);
    const saved = await readJsonFile<PersistedDocument | null>(path, null);

    if (saved !== null && Array.isArray(saved.events)) {
      doc.currentPack = jurisdictions[saved.jurisdiction] ?? GULF_V1;
      doc.meta = saved.meta ?? {};
      try {
        doc.history.replace(saved.events);
      } catch {
        // A document that no longer folds (a hand-edited file, or a jurisdiction that has since
        // dropped a fixture type) must not make the workspace unopenable. Start clean and keep the
        // unreadable file on disk for recovery.
        doc.history.replace(SEED_EVENTS);
      }
    } else {
      doc.history.replace(SEED_EVENTS);
    }
    return doc;
  }

  get pack(): JurisdictionPack {
    return this.currentPack;
  }

  /** Switch jurisdiction and re-fold. Reverts if the document does not survive the new pack. */
  setJurisdiction(pack: JurisdictionPack): void {
    const previous = this.currentPack;
    this.currentPack = pack;
    this.history.invalidate();
    try {
      this.history.state();
    } catch (err) {
      this.currentPack = previous;
      this.history.invalidate();
      throw badRequest(`This design cannot be validated under ${pack.id}: ${err instanceof Error ? err.message : 'unsupported element'}`);
    }
    this.touch();
  }

  assertRoomFor(count: number): void {
    if (this.history.log().length + count > this.maxEvents) {
      throw badRequest(`This document has reached its ${this.maxEvents.toLocaleString('en-US')} edit limit — save it as a project and start a new one`);
    }
  }

  /**
   * Apply edits as one transaction.
   *
   * The request validator checks that each event is well-formed; the model checks that it is
   * *coherent* — that a pipe's endpoints exist, that an id is not already taken, that a slope is
   * being set on something that has one. Those are still the caller's mistakes, so they surface as
   * 400 with the model's own explanation rather than as an unexplained 500.
   */
  apply(events: readonly LayoutEvent[]): void {
    this.assertRoomFor(events.length);
    try {
      this.history.doAll(events);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'That edit is not valid for this model', 'invalid_edit');
    }
  }

  /** Replace the whole log, e.g. opening a saved project or importing a file. */
  replaceAll(events: readonly LayoutEvent[]): void {
    try {
      this.history.replace(events);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'That project could not be opened', 'invalid_document');
    }
  }

  /** Mark the document changed and schedule a write. Coalesces bursts of edits into one save. */
  touch(): void {
    this.lastTouchedAt = Date.now();
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 1000);
    this.saveTimer.unref();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const payload: PersistedDocument = {
      version: 1,
      jurisdiction: this.currentPack.id,
      meta: this.meta,
      events: [...this.history.log()],
      savedAt: new Date().toISOString(),
    };
    try {
      await writeJsonFile(this.path, payload);
    } catch (err) {
      this.dirty = true; // keep it queued; the next edit retries
      console.error(`[documents] failed to save workspace ${this.workspaceId}:`, err instanceof Error ? err.message : err);
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.flush();
  }
}

export class DocumentRegistry {
  private readonly documents = new Map<string, WorkspaceDocument>();
  private readonly loading = new Map<string, Promise<WorkspaceDocument>>();

  private readonly config: Config;
  private readonly jurisdictions: Record<string, JurisdictionPack>;
  private readonly isBusy: (workspaceId: string) => boolean;

  constructor(config: Config, jurisdictions: Record<string, JurisdictionPack>, isBusy: (workspaceId: string) => boolean) {
    this.config = config;
    this.jurisdictions = jurisdictions;
    this.isBusy = isBusy;
  }

  /**
   * Get (or load) a workspace's document. Concurrent requests for the same workspace share one load
   * so two simultaneous edits can never end up folding into two divergent in-memory copies.
   */
  async get(workspaceId: string): Promise<WorkspaceDocument> {
    const resident = this.documents.get(workspaceId);
    if (resident !== undefined) {
      resident.lastTouchedAt = Date.now();
      return resident;
    }
    const pending = this.loading.get(workspaceId);
    if (pending !== undefined) return pending;

    const load = WorkspaceDocument.open(workspaceId, this.config, this.jurisdictions)
      .then(async (doc) => {
        this.documents.set(workspaceId, doc);
        this.loading.delete(workspaceId);
        await this.evictIfNeeded();
        return doc;
      })
      .catch((err) => {
        this.loading.delete(workspaceId);
        throw err;
      });
    this.loading.set(workspaceId, load);
    return load;
  }

  /** Drop a workspace from memory after saving it, e.g. when it is deleted or reset externally. */
  async release(workspaceId: string): Promise<void> {
    const doc = this.documents.get(workspaceId);
    if (doc === undefined) return;
    this.documents.delete(workspaceId);
    await doc.close();
  }

  async closeAll(): Promise<void> {
    const docs = [...this.documents.values()];
    this.documents.clear();
    await Promise.all(docs.map((doc) => doc.close()));
  }

  get residentCount(): number {
    return this.documents.size;
  }

  private async evictIfNeeded(): Promise<void> {
    const limit = this.config.limits.documentsInMemory;
    if (this.documents.size <= limit) return;
    // Never evict a workspace with live collaborators attached; they would silently stop syncing.
    const candidates = [...this.documents.values()]
      .filter((doc) => !this.isBusy(doc.workspaceId))
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);
    for (const doc of candidates) {
      if (this.documents.size <= limit) break;
      this.documents.delete(doc.workspaceId);
      await doc.close();
    }
  }
}
