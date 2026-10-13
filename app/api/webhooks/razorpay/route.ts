import { processWebhook } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay's webhook endpoint, kept at its original path.
 *
 * The generic handler at /api/webhooks/[gateway] does the same job, but
 * deployments that already registered this URL in the Razorpay dashboard
 * should not have to re-register it, so this stays as a one-line delegation
 * rather than a second implementation.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const result = await processWebhook("razorpay", rawBody, request.headers);

  return Response.json(
    {
      received: result.httpStatus < 400,
      outcome: result.outcome,
      detail: result.detail,
    },
    { status: result.httpStatus },
  );
}

export async function GET() {
  return Response.json({ endpoint: "webhook", gateway: "razorpay", method: "POST" });
}
