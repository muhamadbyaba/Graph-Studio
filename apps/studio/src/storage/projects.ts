import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayoutEvent } from '@buildgraph/engineering-core';
import { readJsonFile, writeJsonFile } from '../storage/json-file.ts';
import { badRequest, notFound } from '../http/errors.ts';
import type { ProjectMeta } from '../model/documents.ts';

/**
 * Saved projects: a named snapshot of a workspace's event log that can be reopened later.
 *
 * A project is stored as the events that produced it, not as a rendered model. Reopening replays
 * them, which means an old project picks up every engine improvement made since it was saved, and
 * it can be re-validated under a different jurisdiction without any migration.
 *
 * File naming is the security-relevant part. The display name a user types is kept in the file's
 * contents; the *file name* is a hash of it. Nothing a user types can influence the path, so
 * traversal, reserved Windows device names (`CON`, `PRN`, `LPT1`), case-folding collisions and
 * length limits all stop being concerns rather than being filtered case by case.
 */

export interface ProjectSummary {
  readonly name: string;
  readonly savedAt: string;
  readonly eventCount: number;
}

interface ProjectFile {
  version: 1;
  name: string;
  savedAt: string;
  jurisdiction: string;
  meta: ProjectMeta;
  events: LayoutEvent[];
}

const MAX_NAME_LENGTH = 80;

export class ProjectStore {
  private readonly dataDir: string;
  private readonly maxPerWorkspace: number;

  constructor(dataDir: string, maxPerWorkspace: number) {
    this.dataDir = dataDir;
    this.maxPerWorkspace = maxPerWorkspace;
  }

  async list(workspaceId: string): Promise<ProjectSummary[]> {
    const dir = this.dirFor(workspaceId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const projects: ProjectSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const doc = await readJsonFile<ProjectFile | null>(join(dir, file), null);
      if (doc === null || typeof doc.name !== 'string') continue;
      projects.push({
        name: doc.name,
        savedAt: doc.savedAt ?? '',
        eventCount: Array.isArray(doc.events) ? doc.events.length : 0,
      });
    }
    return projects.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async save(workspaceId: string, name: string, payload: Omit<ProjectFile, 'version' | 'name' | 'savedAt'>): Promise<ProjectSummary> {
    const clean = cleanProjectName(name);
    const path = this.pathFor(workspaceId, clean);

    const existing = await this.list(workspaceId);
    const isNew = !existing.some((p) => p.name === clean);
    if (isNew && existing.length >= this.maxPerWorkspace) {
      throw badRequest(`This workspace has reached its limit of ${this.maxPerWorkspace} saved projects`);
    }

    const doc: ProjectFile = { version: 1, name: clean, savedAt: new Date().toISOString(), ...payload };
    await writeJsonFile(path, doc);
    return { name: clean, savedAt: doc.savedAt, eventCount: doc.events.length };
  }

  async load(workspaceId: string, name: string): Promise<ProjectFile> {
    const clean = cleanProjectName(name);
    const doc = await readJsonFile<ProjectFile | null>(this.pathFor(workspaceId, clean), null);
    if (doc === null || !Array.isArray(doc.events)) throw notFound(`No saved project named "${clean}"`);
    return doc;
  }

  async remove(workspaceId: string, name: string): Promise<void> {
    const clean = cleanProjectName(name);
    try {
      await unlink(this.pathFor(workspaceId, clean));
    } catch {
      // Deleting something that is already gone is the outcome the caller asked for.
    }
  }

  private dirFor(workspaceId: string): string {
    // Workspace ids are server-generated UUIDs, but hash them anyway so this function has no
    // dependence on the id format staying path-safe.
    return join(this.dataDir, 'projects', hash(workspaceId));
  }

  private pathFor(workspaceId: string, name: string): string {
    return join(this.dirFor(workspaceId), `${hash(name)}.json`);
  }
}

export function cleanProjectName(raw: unknown): string {
  // Strip control and formatting characters, then collapse whitespace, so two names that look
  // identical cannot resolve to two different files.
  const name = String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  if (name.length === 0) throw badRequest('A project name is required');
  return name;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}
