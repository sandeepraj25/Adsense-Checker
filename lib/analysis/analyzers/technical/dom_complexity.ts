import type { AnyNode } from "domhandler";

import type { AnalyzerDef } from "../contract";

/**
 * Size and depth of each page's HTML element tree. Very large or deeply
 * nested pages are slow to render and style, especially on phones.
 * Thresholds follow common performance guidance: over 1,500 elements or
 * nesting deeper than 32 levels is a warning.
 */

export function domStats(roots: AnyNode[]): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  const stack: Array<{ node: AnyNode; level: number }> = roots.map((node) => ({ node, level: 1 }));
  while (stack.length > 0) {
    const { node, level } = stack.pop()!;
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
    nodes += 1;
    depth = Math.max(depth, level);
    const children = (node as unknown as { children?: AnyNode[] }).children ?? [];
    for (const child of children) stack.push({ node: child, level: level + 1 });
  }
  return { nodes, depth };
}

export const analyzer: AnalyzerDef = {
  key: "dom_complexity",
  name: "Page complexity (DOM)",
  category: "technical",
  defaultPlan: "pro",
  scope: "page",
  weight: 1,
  warnPriority: "low",
  run(ctx) {
    const { nodes, depth } = domStats(ctx.$("html").toArray());
    const features = { dom_nodes: nodes, dom_depth: depth };
    const summary = `${nodes} elements, nested up to ${depth} levels deep.`;
    if (nodes <= 1500 && depth <= 32) return { status: "pass", findings: [], recommendation: "", summary, features };
    return {
      status: "warn",
      findings: [{ message: `The page has ${nodes} elements nested up to ${depth} levels deep.`, pageUrl: ctx.url }],
      recommendation: "Simplify the page structure: remove unused widgets and wrapper elements, paginate long lists, and avoid page builders' deeply nested layouts where you can.",
      summary,
      features,
    };
  },
};
