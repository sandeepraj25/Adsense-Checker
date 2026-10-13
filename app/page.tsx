import { ScanProvider } from "@/components/ScanContext";
import { ToastProvider } from "@/components/ui/Toast";
import { Navbar } from "@/components/sections/Navbar";
import { Footer } from "@/components/sections/Footer";
import {
  HomeFaq,
  HomeFeatures,
  HomeHero,
  HomePlatformTrust,
  HomePricing,
  HomeProcess,
  HomeReportShowcase,
  LiveApprovalResults,
} from "@/components/home/HomeSections";
import { optionalUser } from "@/lib/auth/guard";
import { expireStaleSubscriptions, getActiveSubscription } from "@/lib/db/billing";
import { siteCurrency } from "@/lib/site-currency";
import { checkoutOptions, checkoutOptionsFor } from "@/lib/payments";
import { listActivePlans } from "@/lib/plan-catalogue";
import { PLANS } from "@/lib/plans";

/**
 * The homepage, with the site's shared navigation bar and footer —
 * unchanged, the same components every public page uses.
 *
 * Rendered per request because the pricing section reads the live plan
 * catalogue and, for a signed-in visitor, their current plan — the same
 * data and the same buttons as /pricing.
 */
export const dynamic = "force-dynamic";

export default async function HomePage() {
  // The site currency an administrator chose; checkout re-prices on the server.
  const currency = siteCurrency();

  const user = await optionalUser();
  if (user) expireStaleSubscriptions();
  const subscription = user ? getActiveSubscription(user.id) : null;

  const plans = listActivePlans();
  const options = checkoutOptionsFor(currency);
  const allOptions = checkoutOptions();
  const freePlan = plans.find((plan) => plan.id === "free");
  const viewer = user && !user.isBlocked ? { name: user.name } : null;

  return (
    <ScanProvider>
      <ToastProvider>
        <a
          href="#top"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-ink-800 focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <Navbar />

        <main>
          <HomeHero viewer={viewer} />
          <HomePlatformTrust />
          <HomeFeatures freeFeatures={freePlan?.features ?? PLANS.free.features} />
          <HomeReportShowcase />
          <HomeProcess />
          <LiveApprovalResults />
          <HomePricing
            plans={plans}
            user={user}
            subscription={subscription}
            currency={currency}
            options={options}
            anyGateway={allOptions.length > 0}
          />
          <HomeFaq paymentMethods={[...new Set(allOptions.map((option) => option.label))]} />
        </main>

        <Footer />
      </ToastProvider>
    </ScanProvider>
  );
}