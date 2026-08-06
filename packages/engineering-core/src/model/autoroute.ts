/**
 * Deterministic auto-routing (Doc 06 §5 "generative design", done without an LLM). Given a set of
 * points (a system root + its fixtures), it returns a minimum-spanning-tree of pipe edges rooted at
 * the root — a sensible, minimal-length branching network the engineer can then refine. Same idea
 * for supply (root = tank), drainage (root = sewer), vent (root = roof terminal).
 */

export interface RoutePoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Prim's MST over Euclidean distance, grown from `rootId`. Returns [from, to] edges (from ∈ tree). */
export function autoRouteEdges(points: readonly RoutePoint[], rootId: string): [string, string][] {
  const pos = new Map(points.map((p) => [p.id, p]));
  if (!pos.has(rootId)) return [];
  const inTree = new Set<string>([rootId]);
  const remaining = points.filter((p) => p.id !== rootId);
  const edges: [string, string][] = [];

  while (remaining.length > 0) {
    let best: RoutePoint | null = null;
    let bestFrom: string | null = null;
    let bestDist = Infinity;
    for (const r of remaining) {
      for (const t of inTree) {
        const a = pos.get(t)!;
        const d = Math.hypot(a.x - r.x, a.y - r.y);
        if (d < bestDist) { bestDist = d; best = r; bestFrom = t; }
      }
    }
    if (!best || !bestFrom) break;
    edges.push([bestFrom, best.id]);
    inTree.add(best.id);
    remaining.splice(remaining.indexOf(best), 1);
  }
  return edges;
}
