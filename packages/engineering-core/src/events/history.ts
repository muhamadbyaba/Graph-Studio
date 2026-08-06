import { foldEvents } from './events.ts';
import type { PlumbingEvent } from './events.ts';
import type { PlumbingNetwork } from '../model/network.ts';
import type { JurisdictionPack } from '../jurisdiction/types.ts';

/**
 * Undo/redo + audit on top of the event log (Doc 02 §4, plumbing spec §4, §11). The cursor marks
 * how many events are "active"; undo/redo move it; a new action after an undo truncates the redo
 * branch (standard editor semantics). `state()` folds the active events into a fresh reactive
 * model — the model is always derivable from its history.
 */
export class ProjectHistory {
  private readonly pack: JurisdictionPack;
  private events: PlumbingEvent[] = [];
  private cursor = 0;

  constructor(pack: JurisdictionPack) {
    this.pack = pack;
  }

  do(event: PlumbingEvent): PlumbingNetwork {
    if (this.cursor < this.events.length) this.events = this.events.slice(0, this.cursor); // drop redo tail
    this.events.push(event);
    this.cursor = this.events.length;
    return this.state();
  }

  undo(): PlumbingNetwork {
    if (this.cursor > 0) this.cursor--;
    return this.state();
  }

  redo(): PlumbingNetwork {
    if (this.cursor < this.events.length) this.cursor++;
    return this.state();
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.events.length;
  }

  /** The current model = fold of the active events. */
  state(): PlumbingNetwork {
    return foldEvents(this.pack, this.events.slice(0, this.cursor));
  }

  /** The audit trail: every active event in order. */
  log(): readonly PlumbingEvent[] {
    return this.events.slice(0, this.cursor);
  }
}
