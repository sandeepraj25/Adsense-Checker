import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { LoginForm } from "@/components/auth/LoginForm";
import { optionalUser } from "@/lib/auth/guard";
import { postLoginPath } from "@/lib/auth/redirect";
import { safeNextPath } from "@/lib/validate";

export const metadata: Metadata = {
  title: "Log in — AdSense Eligibility Checker",
  description:
    "Sign in to your AdSense Eligibility Checker dashboard and manage your website scans and reports.",
};

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Empty when nothing was requested: the server then picks the home for
  // the account's role (admin panel or dashboard) after login.
  const requested = safeNextPath(next, "");

  // Already signed in — go where this account is allowed to go.
  const user = await optionalUser();

  if (user) {
    redirect(postLoginPath(user, requested));
  }

  return (
    <AuthShell
      title="Welcome back"
      lede="Sign in to check your website, review past reports, and continue improving your AdSense eligibility."
      proof={[
        "All your website reports are saved and available anytime",
        "Re-check your website after making improvements",
        "Track your progress and watch your eligibility score improve",
      ]}
      footer={
        <>
          New here?{" "}
          <Link
            href={requested ? `/signup?next=${encodeURIComponent(requested)}` : "/signup"}
            className="text-cloud-50 underline decoration-cloud-600 underline-offset-4 transition-colors hover:decoration-cloud-200"
          >
            Create an account
          </Link>{" "}
          — start with the free plan, no card required.
        </>
      }
    >
      <LoginForm next={requested} />
    </AuthShell>
  );
}