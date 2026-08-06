import { round } from '@buildgraph/engineering-core';
import type { StateSnapshot } from '../model/serialize.ts';

/**
 * The Bill of Quantities as a contractor-ready CSV.
 *
 * Two encoding concerns, not one. RFC 4180 quoting handles commas, quotes and newlines inside a
 * cell. Separately, a cell whose text begins with `=`, `+`, `-`, `@`, tab or carriage return is
 * interpreted by Excel, LibreOffice and Google Sheets as a *formula* — a well-known injection route
 * where an exported description like `=HYPERLINK(...)` runs when a colleague opens the file. Those
 * cells are prefixed with an apostrophe, which spreadsheets strip on display, so the exported text
 * reads correctly while never being evaluated.
 */

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (text.length > 0 && FORMULA_LEADERS.has(text[0])) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildBoqCsv(state: StateSnapshot): string {
  const rows: unknown[][] = [['Discipline', 'Item Code', 'Description', 'Qty', 'Unit', 'Rate', 'Amount']];

  const sorted = [...state.boq].sort((a, b) =>
    (a.group ?? '').localeCompare(b.group ?? '') || a.itemCode.localeCompare(b.itemCode));

  for (const line of sorted) {
    rows.push([line.group ?? '', line.itemCode, line.description, line.qty, line.unit, line.rate ?? '', line.lineCost ?? '']);
  }

  rows.push([]);
  rows.push(['', '', '', '', '', 'Project Total', round(state.costTotal, 2)]);
  rows.push(['', '', `Jurisdiction ${state.jurisdiction}. Unit rates are representative and require verification. Decision-support output, subject to Engineer-of-Record sign-off.`]);

  // CRLF line endings: what RFC 4180 specifies and what Excel expects on every platform.
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
