/**
 * CSV for the analytics exports.
 *
 * A cell that begins with = + - @ (or a tab / carriage return) is
 * prefixed with an apostrophe, so a spreadsheet never runs it as a
 * formula — a page path or campaign name is visitor-controlled text and
 * must not become `=HYPERLINK(...)` in an admin's spreadsheet.
 */

export type Cell = string | number | null | undefined;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !(typeof value === "number")) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  // BOM so Excel opens UTF-8 (₹) correctly.
  return `﻿${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
