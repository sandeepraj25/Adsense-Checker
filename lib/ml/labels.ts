/**
 * How much each label is trusted when training — explainable rules, each
 * leaving a note on the row so the admin page can show why a label counts
 * for less. A label is never deleted by these rules; at worst it counts
 * for a fraction of a normal label.
 *
 *   R1  Only accepted labels train. Deferred (young account), superseded
 *       (corrected) and excluded labels have weight 0 — and say so.
 *   R2  Contradiction: when different accounts report opposite outcomes
 *       for the same site within 30 days of each other, each of those
 *       labels counts half. One of them is probably wrong, and we cannot
 *       tell which.
 *   R3  Volume: an account that has given more than 20 labels within 30
 *       days of a label has that label scaled by 20 / count, so no single
 *       account can dominate the training set.
 *
 * Pure: takes rows, returns weights and notes. Order-independent.
 */

export type LabelRow = {
  id: string;
  userId: string;
  domain: string;
  label: "approved" | "rejected";
  labelStatus: string;
  labeledAt: number;
};

export type LabelWeight = { id: string; weight: number; notes: string[] };

const WINDOW_MS = 30 * 86_400_000;
const VOLUME_LIMIT = 20;

export function labelWeights(rows: LabelRow[]): LabelWeight[] {
  const byDomain = new Map<string, LabelRow[]>();
  const byUser = new Map<string, LabelRow[]>();
  for (const row of rows) {
    if (row.labelStatus !== "accepted") continue;
    (byDomain.get(row.domain) ?? byDomain.set(row.domain, []).get(row.domain)!).push(row);
    (byUser.get(row.userId) ?? byUser.set(row.userId, []).get(row.userId)!).push(row);
  }

  return rows.map((row) => {
    if (row.labelStatus !== "accepted") {
      return { id: row.id, weight: 0, notes: [`Not used: label is ${row.labelStatus}.`] };
    }
    let weight = 1;
    const notes: string[] = [];

    const contradicted = (byDomain.get(row.domain) ?? []).some(
      (other) => other.userId !== row.userId && other.label !== row.label && Math.abs(other.labeledAt - row.labeledAt) <= WINDOW_MS,
    );
    if (contradicted) {
      weight *= 0.5;
      notes.push("Counts half: another account reported the opposite outcome for this site within 30 days.");
    }

    const nearby = (byUser.get(row.userId) ?? []).filter((other) => Math.abs(other.labeledAt - row.labeledAt) <= WINDOW_MS).length;
    if (nearby > VOLUME_LIMIT) {
      weight *= VOLUME_LIMIT / nearby;
      notes.push(`Scaled to ${Math.round((VOLUME_LIMIT / nearby) * 100)}%: this account gave ${nearby} labels within 30 days.`);
    }

    return { id: row.id, weight: Math.round(weight * 1000) / 1000, notes };
  });
}
