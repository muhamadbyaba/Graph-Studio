import { PlumbingLayout } from '../model/layout.ts';
import type { LayoutNodeKind, Medium, PipeProduct, Waypoint } from '../model/layout.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/** Event-sourced edits for the geometric layout (Doc 02 §4). Serializable → persistable → replayable. */
export type LayoutEvent =
  | { readonly type: 'NodeAdded'; readonly id: string; readonly kind: LayoutNodeKind; readonly x: number; readonly y: number; readonly fixtureType?: string; readonly z?: number }
  | { readonly type: 'PipeAdded'; readonly id: string; readonly from: string; readonly to: string; readonly medium: Medium; readonly slopePct?: number }
  | { readonly type: 'NodeMoved'; readonly id: string; readonly x: number; readonly y: number }
  | { readonly type: 'NodeElevationChanged'; readonly id: string; readonly z: number }
  | { readonly type: 'NodeRotated'; readonly id: string; readonly deg: number }
  | { readonly type: 'FixtureTypeChanged'; readonly id: string; readonly fixtureType: string }
  | { readonly type: 'NodeLoadChanged'; readonly id: string; readonly amps: number }
  | { readonly type: 'NodeAirflowChanged'; readonly id: string; readonly airLps: number }
  | { readonly type: 'BeamLoadChanged'; readonly id: string; readonly loadKnPerM: number }
  | { readonly type: 'AxialLoadChanged'; readonly id: string; readonly axialLoadKn: number | null }
  | { readonly type: 'FloorsSupportedChanged'; readonly id: string; readonly floors: number }
  | { readonly type: 'SlabAdded'; readonly id: string; readonly corners: readonly string[]; readonly loadKnPerM2?: number }
  | { readonly type: 'SlabLoadChanged'; readonly id: string; readonly loadKnPerM2: number }
  | { readonly type: 'SlabRemoved'; readonly id: string }
  | { readonly type: 'PipeSlopeChanged'; readonly id: string; readonly slopePct: number }
  | { readonly type: 'StackFloorsSet'; readonly id: string; readonly floors: number }
  | { readonly type: 'PipeSizeSet'; readonly id: string; readonly odMm: number | null }
  | { readonly type: 'PipeProductSet'; readonly id: string; readonly product: PipeProduct | null }
  | { readonly type: 'PipeReroute'; readonly id: string; readonly waypoints: readonly Waypoint[] }
  | { readonly type: 'SupplyPressureSet'; readonly kPa: number }
  | { readonly type: 'RecircFlowSet'; readonly lps: number }
  | { readonly type: 'SourceSet'; readonly id: string }
  | { readonly type: 'OutletSet'; readonly id: string }
  | { readonly type: 'VentTerminalSet'; readonly id: string }
  | { readonly type: 'PanelSet'; readonly id: string }
  | { readonly type: 'AhuSet'; readonly id: string }
  | { readonly type: 'NodeRemoved'; readonly id: string }
  | { readonly type: 'PipeRemoved'; readonly id: string };

export function foldLayoutEvents(pack: JurisdictionPack, events: readonly LayoutEvent[]): PlumbingLayout {
  const layout = new PlumbingLayout(pack);
  for (const e of events) applyLayoutEvent(layout, e);
  return layout;
}

function applyLayoutEvent(layout: PlumbingLayout, e: LayoutEvent): void {
  switch (e.type) {
    case 'NodeAdded': layout.addNode(e.id, e.kind, e.x, e.y, e.fixtureType, e.z); return;
    case 'PipeAdded': layout.addPipe(e.id, e.from, e.to, e.medium, e.slopePct); return;
    case 'NodeMoved': layout.moveNode(e.id, e.x, e.y); return;
    case 'NodeElevationChanged': layout.setElevation(e.id, e.z); return;
    case 'NodeRotated': layout.setRotation(e.id, e.deg); return;
    case 'FixtureTypeChanged': layout.setFixtureType(e.id, e.fixtureType); return;
    case 'NodeLoadChanged': layout.setLoad(e.id, e.amps); return;
    case 'NodeAirflowChanged': layout.setAirflow(e.id, e.airLps); return;
    case 'BeamLoadChanged': layout.setBeamLoad(e.id, e.loadKnPerM); return;
    case 'AxialLoadChanged': layout.setAxialLoad(e.id, e.axialLoadKn); return;
    case 'FloorsSupportedChanged': layout.setFloorsSupported(e.id, e.floors); return;
    case 'SlabAdded': layout.addSlab(e.id, e.corners, e.loadKnPerM2); return;
    case 'SlabLoadChanged': layout.setSlabLoad(e.id, e.loadKnPerM2); return;
    case 'SlabRemoved': layout.removeSlab(e.id); return;
    case 'PipeSlopeChanged': layout.setPipeSlope(e.id, e.slopePct); return;
    case 'StackFloorsSet': layout.setStackFloors(e.id, e.floors); return;
    case 'PipeSizeSet': layout.setPipeSize(e.id, e.odMm); return;
    case 'PipeProductSet': layout.setPipeProduct(e.id, e.product); return;
    case 'PipeReroute': layout.setPipeWaypoints(e.id, e.waypoints); return;
    case 'SupplyPressureSet': layout.setSupplyPressure(e.kPa); return;
    case 'RecircFlowSet': layout.setRecircFlow(e.lps); return;
    case 'SourceSet': layout.setSource(e.id); return;
    case 'OutletSet': layout.setOutlet(e.id); return;
    case 'VentTerminalSet': layout.setVentTerminal(e.id); return;
    case 'PanelSet': layout.setPanel(e.id); return;
    case 'AhuSet': layout.setAhu(e.id); return;
    case 'NodeRemoved': layout.removeNode(e.id); return;
    case 'PipeRemoved': layout.removePipe(e.id); return;
  }
}
