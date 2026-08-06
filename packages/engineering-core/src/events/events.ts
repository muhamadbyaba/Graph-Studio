import { PlumbingNetwork } from '../model/network.ts';
import type { Medium } from '../model/network.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Event sourcing (Doc 02 §4). Every edit is a serializable, append-only event. The current model
 * is the *fold* of its event log — which gives version history, undo/redo, time-travel, and an
 * audit trail without any bespoke machinery. Events are plain data so a real deployment can persist
 * them to an append-only store and rebuild any project state on demand.
 */

export type PlumbingEvent =
  | { readonly type: 'SourceSet'; readonly id: string }
  | { readonly type: 'PipeAdded'; readonly id: string; readonly medium: Medium; readonly lengthM: number }
  | { readonly type: 'FixtureAdded'; readonly id: string; readonly fixtureType: string }
  | { readonly type: 'Connected'; readonly a: string; readonly b: string }
  | { readonly type: 'FixtureTypeChanged'; readonly id: string; readonly fixtureType: string }
  | { readonly type: 'PipeLengthChanged'; readonly id: string; readonly lengthM: number };

/** Rebuild a live, reactive network by replaying events in order. */
export function foldEvents(pack: JurisdictionPack, events: readonly PlumbingEvent[]): PlumbingNetwork {
  const net = new PlumbingNetwork(pack);
  for (const event of events) applyEvent(net, event);
  return net;
}

function applyEvent(net: PlumbingNetwork, event: PlumbingEvent): void {
  switch (event.type) {
    case 'SourceSet':
      net.setSource(event.id);
      return;
    case 'PipeAdded':
      net.addPipe(event.id, event.medium, event.lengthM);
      return;
    case 'FixtureAdded':
      net.addFixture(event.id, event.fixtureType);
      return;
    case 'Connected':
      net.connect(event.a, event.b);
      return;
    case 'FixtureTypeChanged': {
      const f = net.fixtures.get(event.id);
      if (!f) throw new Error(`FixtureTypeChanged: unknown fixture '${event.id}'`);
      f.type.set(event.fixtureType);
      return;
    }
    case 'PipeLengthChanged': {
      const p = net.pipes.get(event.id);
      if (!p) throw new Error(`PipeLengthChanged: unknown pipe '${event.id}'`);
      p.lengthM.set(event.lengthM);
      return;
    }
  }
}
