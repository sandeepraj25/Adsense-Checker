import { many, one, type SqlValue } from "@/lib/db";
import type { Bucket } from "./time";

/**
 * Shared helpers for the report queries. Every query takes its time
 * window as parameters; the only strings ever spliced into SQL are the
 * constant fragments defined in this codebase, never request input.
 */

export type Window = { start: number; end: number };

export type ReportScope = Window & {
  /** Include visits flagged as internal (only exist when internal mode is "flag"). */
  includeInternal: boolean;
};

export function scalar(sql: string, params: SqlValue[] = []): number {
  return Number(one<{ n: number | null }>(sql, params)?.n ?? 0);
}

export function nullableScalar(sql: string, params: SqlValue[] = []): number | null {
  const n = one<{ n: number | null }>(sql, params)?.n;
  return n === null || n === undefined ? null : Number(n);
}

export function bucketsJson(list: Bucket[]): string {
  return JSON.stringify(list.map((b) => [b.start, b.end]));
}

/**
 * One aggregate per bucket in a single query. `from` is the table (with
 * alias t), `ts` the timestamp column on t, `where` extra constant
 * conditions joined with AND (may reference t), and `agg` the aggregate.
 *
 * The buckets arrive as one JSON parameter and are expanded by
 * json_each, so a 366-day range is still one statement and each bucket
 * is an index range scan on the timestamp.
 */
export function perBucket(input: {
  list: Bucket[];
  from: string;
  ts: string;
  agg: string;
  where?: string;
  params?: SqlValue[];
}): number[] {
  if (input.list.length === 0) return [];
  const rows = many<{ i: number; n: number | null }>(
    `SELECT CAST(b.key AS INTEGER) AS i, ${input.agg} AS n
       FROM json_each(?) b
       LEFT JOIN ${input.from}
         ON ${input.ts} >= json_extract(b.value, '$[0]')
        AND ${input.ts} <  json_extract(b.value, '$[1]')
        ${input.where ? `AND ${input.where}` : ""}
      GROUP BY b.key`,
    [bucketsJson(input.list), ...(input.params ?? [])],
  );
  const out = new Array<number>(input.list.length).fill(0);
  for (const row of rows) out[row.i] = Number(row.n ?? 0);
  return out;
}

export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export type Ranked = { label: string; value: number; secondary?: number | null; extra?: Record<string, number | string | null> };

export type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };

export function clampPage(raw: unknown, pageSize: number, total: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : 1;
  const max = Math.max(1, Math.ceil(total / pageSize));
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : 1;
}
