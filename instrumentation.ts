/**
 * Runs once when the server starts (Next.js instrumentation hook).
 * The Node-only work lives in instrumentation-node.ts, imported behind the
 * literal runtime check Next.js uses to keep it out of the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
