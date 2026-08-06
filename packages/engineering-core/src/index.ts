// Engineering Core (reusable by every discipline)
export * from './units/index.ts';
export * from './rules/rule.ts';
export { RuleRegistry } from './rules/registry.ts';
export { Signal, Source, Derived, source, derived } from './core/reactive.ts';
export { aggregate, round } from './boq/boq.ts';
export { defaultRate } from './boq/costbook.ts';
export type { BoqLine } from './boq/boq.ts';
export type { JurisdictionPack, PprSize, HunterAnchor } from './jurisdiction/types.ts';
export { GULF_V1 } from './jurisdiction/gulf.ts';
export { US_V1 } from './jurisdiction/us.ts';
export { JURISDICTIONS, jurisdictionList } from './jurisdiction/registry.ts';

// Plumbing / PPR module (the reference discipline)
export { velocity, hazenWilliamsHeadloss, pprInnerDiameter } from './plumbing/hydraulics.ts';
export { sumWsfu, hunterDemand } from './plumbing/demand.ts';
export type { FixtureCount } from './plumbing/demand.ts';
export { solveNetworkPressure, RHO_G_KPA_PER_M } from './plumbing/pressure.ts';
export type { PressureAnalysis, NodePressure, FixturePressure, PressureNodeInput, PressureEdgeInput, PressureRemedy } from './plumbing/pressure.ts';
export { analyzeRecirc } from './plumbing/recirc.ts';
export type { RecircAnalysis, RecircEdgeInput, RecircBranch } from './plumbing/recirc.ts';
export { analyzeDwv } from './plumbing/dwv.ts';
export type { DwvAnalysis, DwvFixtureInput, DwvEdgeInput, DwvFixtureStatus } from './plumbing/dwv.ts';
export { sizeSupplyPipeRule } from './plumbing/sizing.ts';
export type { SizeSupplyPipeInput } from './plumbing/sizing.ts';
export { velocityCheckRule, headlossRule } from './plumbing/rules.ts';
export type { VelocityCheckInput, HeadlossInput } from './plumbing/rules.ts';
export { sizeDrainOd, minSlopePct, manningVelocity, sizeDrainRule, drainSlopeRule, drainVelocityRule, sizeVentOd, sizeVentRule, maxBranchIntervalDfu, stackBranchRule } from './plumbing/drainage.ts';
export type { SizeDrainInput, DrainSlopeInput, DrainVelocityInput, SizeVentInput, StackBranchInput } from './plumbing/drainage.ts';
export { sizeDuctOd, sizeDuctRule, ductVelocityRule } from './hvac/ducts.ts';
export type { SizeDuctInput, DuctVelocityInput } from './hvac/ducts.ts';
export { sizeBeamRule } from './structural/beams.ts';
export type { SizeBeamInput } from './structural/beams.ts';
export { sizeColumnRule } from './structural/columns.ts';
export type { SizeColumnInput } from './structural/columns.ts';
export { sizeSlabRule } from './structural/slabs.ts';
export type { SizeSlabInput, SlabPoint } from './structural/slabs.ts';
export type { DrainSize, SlopeRule } from './jurisdiction/types.ts';

// Reactive model (the propagation graph applied to a plumbing network)
export { PlumbingNetwork } from './model/network.ts';
export type { Medium, FixtureCell, PipeCell } from './model/network.ts';

// Event sourcing (undo/redo, version history, audit)
export { foldEvents } from './events/events.ts';
export type { PlumbingEvent } from './events/events.ts';
export { ProjectHistory } from './events/history.ts';
export { History } from './events/generic-history.ts';

// Geometric layout model (the drawing-canvas model) + its events
export { PlumbingLayout } from './model/layout.ts';
export type { LayoutNode, LayoutPipe, LayoutNodeKind, Medium as LayoutMedium, PipeProduct, Slab, Waypoint } from './model/layout.ts';
export { foldLayoutEvents } from './events/layout-events.ts';
export type { LayoutEvent } from './events/layout-events.ts';
export { autoRouteEdges } from './model/autoroute.ts';
export type { RoutePoint } from './model/autoroute.ts';

// Component / product library (cross-discipline catalog)
export { DEFAULT_CATALOG, disciplines, filterCatalog, slug } from './catalog/catalog.ts';
export type { CatalogItem } from './catalog/catalog.ts';

// Geometry — horizontal section cut (imported 3D model → traceable 2D floor plan)
export { sliceMeshAtZ, segmentBounds, fitSegmentsToBox, zRange } from './geometry/section.ts';
export type { Vec2, Segment2, Bounds2 } from './geometry/section.ts';

// AI copilot grounding (tool bus + the "numbers only from tools" guardrail)
export { ToolBus, extractNumbers } from './ai/toolbus.ts';
export type { ToolDef, ToolCallRecord, SideEffect } from './ai/toolbus.ts';
export { guardNumericClaims } from './ai/guardrail.ts';
export type { GuardResult } from './ai/guardrail.ts';
export { buildMepToolBus } from './ai/mep-tools.ts';
export { answerQuestion } from './ai/assistant.ts';
export type { AskContext } from './ai/assistant.ts';

// Electrical module (second discipline — proves the blueprint reuses the same core)
export { voltageDrop, designCurrentSinglePhase } from './electrical/electrics.ts';
export type { Phase } from './electrical/electrics.ts';
export { sizeCableRule } from './electrical/sizing.ts';
export type { SizeCableInput } from './electrical/sizing.ts';
export { ampacityCheckRule, voltageDropCheckRule } from './electrical/rules.ts';
export type { AmpacityCheckInput, VoltageDropCheckInput } from './electrical/rules.ts';
export type { CableSize } from './jurisdiction/types.ts';
