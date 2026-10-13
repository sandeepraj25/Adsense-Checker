import { processWebhook } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One webhook endpoint per gateway: /api/webhooks/razorpay,
 * /api/webhooks/cashfree, /api/webhooks/paypal.
 *
 * The body is read as raw text and passed through untouched, because every
 * signature here covers the exact bytes the gateway sent — parsing and
 * re-serialising would silently break verification.
 *
 * Status codes are chosen for how gateways behave, not for tidiness. 2xx
 * stops the retries, so it is used for anything final, including duplicates
 * and events we deliberately ignore. 4xx marks a delivery that will never
 * become valid. 5xx asks for a retry and is reserved for our own transient
 * failures.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ gateway: string }> },
) {
  const { gateway } = await context.params;
  const rawBody = await request.text();

  const result = await processWebhook(gateway, rawBody, request.headers);

  return Response.json(
    { received: result.httpStatus < 400, outcome: result.outcome, detail: result.detail },
    { status: result.httpStatus },
  );
}

/**
 * Gateways probe the URL with a GET when you register it. Answering
 * something plain beats a 405 in the dashboard's verification step.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ gateway: string }> },
) {
  const { gateway } = await context.params;
  return Response.json({ endpoint: "webhook", gateway, method: "POST" });
}
