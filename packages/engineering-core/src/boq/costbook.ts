/**
 * Representative unit-rate book (Doc 03 §8.3 cost intelligence). Maps a BOQ item to a unit rate so
 * every quantity can carry a cost and the project shows a live total. ⚠ All rates are illustrative
 * **[VERIFY]** — a real deployment loads a region/date-stamped cost database; product-linked lines
 * use the product's own price instead of these defaults.
 */

const PPR: Record<number, number> = { 20: 2.5, 25: 3.2, 32: 4.5, 40: 6, 50: 8.5, 63: 12, 75: 17, 90: 24, 110: 33 };
const DRAIN: Record<number, number> = { 40: 3, 50: 4, 75: 7, 110: 11, 160: 20 };
const VENT: Record<number, number> = { 40: 2.5, 50: 3.5, 75: 6, 110: 10 };
const CABLE: Record<number, number> = { 1.5: 1.2, 2.5: 1.8, 4: 2.8, 6: 4, 10: 6.5, 16: 10, 25: 15 };
const DUCT: Record<number, number> = { 100: 12, 125: 15, 160: 19, 200: 25, 250: 32, 315: 42, 400: 55, 500: 72, 630: 95 };
const BEAM: Record<number, number> = { 300: 45, 400: 60, 500: 80, 600: 105, 750: 145, 900: 190 };

function pick(table: Record<number, number>, key: number | null, fallback: number): number {
  return key != null && table[key] != null ? table[key] : fallback;
}

/** Unit rate for a BOQ itemCode. Returns 0 for product lines (those carry their own price). */
export function defaultRate(itemCode: string): number {
  const num = (re: RegExp): number | null => { const m = itemCode.match(re); return m ? Number(m[1]) : null; };
  if (itemCode.startsWith('PPR-OD')) return pick(PPR, num(/OD(\d+)/), 5);
  if (itemCode.startsWith('DRAIN-OD')) return pick(DRAIN, num(/OD(\d+)/), 8);
  if (itemCode.startsWith('VENT-OD')) return pick(VENT, num(/OD(\d+)/), 6);
  if (itemCode.startsWith('CABLE-')) return pick(CABLE, num(/CABLE-([\d.]+)/), 5);
  if (itemCode.startsWith('DUCT-')) return pick(DUCT, num(/DUCT-(\d+)/), 30);
  if (itemCode.startsWith('BEAM-')) return pick(BEAM, num(/BEAM-(\d+)/), 80);
  if (itemCode.startsWith('FIX-')) return 60;
  if (itemCode.startsWith('FIT-')) return 4; // PPR fitting, nominal [VERIFY]
  if (itemCode === 'ELEC-load') return 15;
  if (itemCode === 'HVAC-diffuser') return 45;
  return 0;
}
