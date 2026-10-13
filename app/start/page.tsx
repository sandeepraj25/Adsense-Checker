import { redirect } from "next/navigation";

import { optionalUser } from "@/lib/auth/guard";
import { expireStaleSubscriptions, getActiveSubscription } from "@/lib/db/billing";
import { normalizeDomain } from "@/lib/domain";

/**
 * The junction between the marketing site and the product.
 *
 * The homepage is a static shell — it cannot know whether the visitor
 * has a session — so the URL form posts them here and this route makes
 * the decision on the server:
 *
 *   anonymous            → /signup, carrying the URL and a return path
 *   signed in, no plan   → /pricing, carrying the URL
 *   signed in, usable    → /dashboard/checker, which starts the run
 *
 * Rendering nothing is the point: this page only ever redirects.
 */
export const dynamic = "force-dynamic";

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;
  const domain = normalizeDomain(url ?? "");
  const query = domain ? `?url=${encodeURIComponent(domain)}` : "";

  const user = await optionalUser();

  if (!user) {
    const next = `/dashboard/checker${query}`;
    redirect(
      `/signup?next=${encodeURIComponent(next)}${domain ? `&url=${encodeURIComponent(domain)}` : ""}`,
    );
  }

  expireStaleSubscriptions();
  const subscription = getActiveSubscription(user.id);

  if (!subscription || !subscription.isUsable) {
    redirect(`/pricing${query}`);
  }

  redirect(`/dashboard/checker${query}${query ? "&" : "?"}run=1`);
}
