import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { SignupForm } from "@/components/auth/SignupForm";
import { optionalUser } from "@/lib/auth/guard";
import { postLoginPath } from "@/lib/auth/redirect";
import { normalizeDomain } from "@/lib/domain";
import { safeNextPath } from "@/lib/validate";

export const metadata: Metadata = {
  title: "Sign Up — AdSense Eligibility Checker",
  description:
    "Create a free AdSense Eligibility Checker account and check your website's AdSense eligibility.",
};

export const dynamic = "force-dynamic";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; url?: string; plan?: string }>;
}) {
  const { next, url } = await searchParams;
  const domain = normalizeDomain(url ?? "");

  // If a website URL was provided, send the user directly
  // to the checker after signup.
  const fallback = domain
    ? `/dashboard/checker?url=${encodeURIComponent(domain)}`
    : "/dashboard";

  const target = safeNextPath(next, fallback);

  const user = await optionalUser();

  if (user) {
    redirect(postLoginPath(user, target));
  }

  return (
    <AuthShell
      title="Create your account"
      lede="Start on the free plan — no card needed. You can upgrade whenever you want more scans."
      proof={[
        "Free website eligibility checks",
        "A clear AdSense eligibility score",
        "Detailed issues and improvement suggestions",
        "Reports saved to your dashboard",
      ]}
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={`/login?next=${encodeURIComponent(target)}`}
            className="text-cloud-50 underline decoration-cloud-600 underline-offset-4 transition-colors hover:decoration-cloud-200"
          >
            Log in
          </Link>
        </>
      }
    >
      <SignupForm next={target} />
    </AuthShell>
  );
}