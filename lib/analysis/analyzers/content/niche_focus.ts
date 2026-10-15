import type { AnalyzerDef } from "../contract";
import { contentPagesOf, mainContent, words } from "../util";

/**
 * Whether the articles read are about one subject or many.
 *
 * Each content page becomes a TF-IDF vector of its 25 most distinctive
 * words (common function words removed); pages whose vectors are similar
 * (cosine ≥ 0.12) are grouped. Few groups means a focused site; nearly
 * every page in its own group means scattered topics, which reads as a
 * site built to catch traffic rather than to serve readers. It needs at
 * least three pages, and with only a handful read it is a weak signal.
 */

const STOP = new Set("the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what about after again also back because before being below between both could down each even every first into most other should their there these those through under until where which while would yours make made like just than then them they this that what when your into more most some such only also very much many each other about would could should their there these those which while where after before because through".split(" "));
const THRESHOLD = 0.12;

function vectors(docs: string[][]): Array<Map<string, number>> {
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  return docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
    const weighted = [...tf].map(([term, n]) => [term, (n / doc.length) * Math.log((1 + docs.length) / (1 + (df.get(term) ?? 0)) + 1)] as const);
    weighted.sort((a, b) => b[1] - a[1]);
    const top = weighted.slice(0, 25);
    const norm = Math.sqrt(top.reduce((sum, [, w]) => sum + w * w, 0)) || 1;
    return new Map(top.map(([term, w]) => [term, w / norm]));
  });
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let sum = 0;
  for (const [term, w] of a) sum += w * (b.get(term) ?? 0);
  return sum;
}

export function topicGroups(texts: string[]): { groups: number[][]; mean: number; terms: string[][] } {
  const docs = texts.map((t) => words(t).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)));
  const vecs = vectors(docs);
  const parent = vecs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vecs.length; i += 1) {
    for (let j = i + 1; j < vecs.length; j += 1) {
      const sim = cosine(vecs[i]!, vecs[j]!);
      total += sim;
      pairs += 1;
      if (sim >= THRESHOLD) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  vecs.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const list = [...groups.values()];
  const terms = list.map((members) => {
    const sum = new Map<string, number>();
    for (const m of members) for (const [t, w] of vecs[m]!) sum.set(t, (sum.get(t) ?? 0) + w);
    return [...sum].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
  });
  return { groups: list, mean: pairs ? total / pairs : 1, terms };
}

export const analyzer: AnalyzerDef = {
  key: "niche_focus",
  name: "Topic focus",
  category: "content",
  defaultPlan: "pro",
  scope: "site",
  weight: 2,
  warnPriority: "low",
  run(ctx) {
    const pages = contentPagesOf(ctx.crawledPages, ctx.siteMeta).filter((p) => p.finalUrl !== ctx.siteMeta.home.finalUrl);
    const texts = pages.map((p) => mainContent(p.$())).filter((t) => words(t).length >= 80);
    if (texts.length < 3) {
      return { status: "pass", findings: [], recommendation: "", confidence: "low", summary: `Not measured: needs at least three articles with 80+ words (${texts.length} read).` };
    }
    const { groups, mean, terms } = topicGroups(texts);
    const features = { topic_groups: groups.length, topic_similarity: Number(mean.toFixed(3)), topic_pages: texts.length };
    const scattered = groups.length > Math.max(2, Math.ceil(texts.length / 2)) && mean < THRESHOLD;
    const labels = terms.map((t) => t.join(", "));
    if (!scattered) {
      return { status: "pass", findings: [], recommendation: "", confidence: texts.length >= 5 ? "medium" : "low", summary: `${texts.length} articles fall into ${groups.length} topic group(s): ${labels.slice(0, 3).join(" / ")}.`, features };
    }
    return {
      status: "warn",
      confidence: texts.length >= 5 ? "medium" : "low",
      findings: labels.slice(0, 6).map((label, i) => ({ message: `Topic group ${i + 1}: ${label}`, evidence: `${groups[i]!.length} article(s)` })),
      recommendation: "Focus the site on one subject (or a few closely related ones) and organise posts into categories. A site covering everything reads as made for traffic rather than for readers.",
      summary: `${texts.length} articles cover ${groups.length} unrelated topics.`,
      features,
    };
  },
};
