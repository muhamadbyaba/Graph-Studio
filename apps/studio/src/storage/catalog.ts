import { join } from 'node:path';
import { DEFAULT_CATALOG, filterCatalog, slug } from '@buildgraph/engineering-core';
import type { CatalogItem } from '@buildgraph/engineering-core';
import { readJsonFile, writeJsonFile } from '../storage/json-file.ts';
import { badRequest } from '../http/errors.ts';

/**
 * The component library: the built-in catalogue plus items users add.
 *
 * User items are scoped to the workspace that created them, so one tenant's product list is not
 * visible to another. Every field is validated and length-bounded on the way in, and the free-form
 * `spec` object is flattened to primitives — a nested structure of unknown shape is the kind of
 * thing that ends up interpolated into a UI somewhere and turns into a stored injection.
 */

const MAX_NAME = 80;
const MAX_SPEC_KEYS = 24;
const MAX_SPEC_VALUE = 60;
const TEXT_PATTERN = /^[^\p{Cc}\p{Cf}]{1,80}$/u;

export interface StoredCatalogItem extends CatalogItem {
  readonly workspaceId: string;
  readonly createdAt: string;
}

export class CatalogStore {
  private items: StoredCatalogItem[] = [];
  private readonly path: string;

  private readonly maxItems: number;

  private constructor(dataDir: string, maxItems: number) {
    this.maxItems = maxItems;
    this.path = join(dataDir, 'catalog.json');
  }

  static async open(dataDir: string, maxItems: number): Promise<CatalogStore> {
    const store = new CatalogStore(dataDir, maxItems);
    const saved = await readJsonFile<StoredCatalogItem[]>(store.path, []);
    store.items = Array.isArray(saved) ? saved.filter((i) => typeof i?.id === 'string') : [];
    return store;
  }

  /** Built-in items plus this workspace's own, filtered by discipline and free text. */
  query(workspaceId: string, options: { discipline?: string; query?: string }): { items: CatalogItem[]; disciplines: string[]; total: number } {
    const all: CatalogItem[] = [...DEFAULT_CATALOG, ...this.items.filter((i) => i.workspaceId === workspaceId)];
    return {
      items: filterCatalog(all, options),
      disciplines: [...new Set(all.map((i) => i.discipline))].sort(),
      total: all.length,
    };
  }

  async add(workspaceId: string, input: unknown): Promise<CatalogItem> {
    if (this.items.filter((i) => i.workspaceId === workspaceId).length >= this.maxItems) {
      throw badRequest(`This workspace has reached its limit of ${this.maxItems} custom components`);
    }

    const body = (input ?? {}) as Record<string, unknown>;
    const discipline = text(body.discipline, 'discipline');
    const category = text(body.category, 'category');
    const name = text(body.name, 'name');
    const unit = body.unit === undefined || body.unit === null || body.unit === '' ? 'nr' : text(body.unit, 'unit');

    const item: StoredCatalogItem = {
      id: slug(`${discipline}-${category}-${name}-${Date.now().toString(36)}`),
      discipline,
      category,
      name,
      spec: cleanSpec(body.spec),
      unit,
      price: body.price === undefined || body.price === null || body.price === '' ? undefined : positive(body.price, 'price'),
      manufacturer: body.manufacturer === undefined || body.manufacturer === null || body.manufacturer === '' ? undefined : text(body.manufacturer, 'manufacturer'),
      custom: true,
      workspaceId,
      createdAt: new Date().toISOString(),
    };

    this.items.push(item);
    await writeJsonFile(this.path, this.items);

    const { workspaceId: _scope, createdAt: _created, ...published } = item;
    return published;
  }
}

function text(value: unknown, field: string): string {
  const s = String(value ?? '').trim().slice(0, MAX_NAME);
  if (s.length === 0) throw badRequest(`"${field}" is required`);
  if (!TEXT_PATTERN.test(s)) throw badRequest(`"${field}" contains unsupported characters`);
  return s;
}

function positive(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw badRequest(`"${field}" must be a positive number`);
  return n;
}

/** Flatten a user-supplied spec to a small map of short primitive values. */
function cleanSpec(input: unknown): Record<string, string | number> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const spec: Record<string, string | number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_SPEC_KEYS) break;
    const cleanKey = key.trim().slice(0, 32);
    if (cleanKey.length === 0 || !TEXT_PATTERN.test(cleanKey)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) spec[cleanKey] = value;
    else if (typeof value === 'string' || typeof value === 'boolean') {
      const s = String(value).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, MAX_SPEC_VALUE);
      if (s.length > 0) spec[cleanKey] = s;
    } else continue;
    count++;
  }
  return spec;
}
