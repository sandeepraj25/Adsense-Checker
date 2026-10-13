import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { VerifyEmailForm } from "@/components/auth/VerifyEmailForm";
import { ButtonLink } from "@/components/ui/Button";
import {
  RESEND_COOLDOWN_MS,
  currentPending,
  maskEmail,
} from "@/lib/auth/email-verification";
import { optionalUser } from "@/lib/auth/guard";
import { postLoginPath } from "@/lib/auth/redirect";

export const metadata: Metadata = {
  title: "Verify your email — AdSense Eligibility Checker",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const proof = [
  "The code only works in the browser you signed up in",
  "It expires after 10 minutes and works once",
  "Your account is created only after the code is confirmed",
];

/**
 * Step 2 of sign-up. Which sign-up this is comes from the httpOnly
 * verification cookie; nothing in the URL identifies it, so the page
 * cannot be pointed at someone else's address.
 */
export default async function VerifyEmailPage() {
  const user = await optionalUser();
  if (user) redirect(postLoginPath(user, null));

  const pending = await currentPending();

  if (!pending) {
    return (
      <AuthShell
        title="No verification in progress"
        lede="This link has ended, or the sign-up was started in another browser. Sign up again, or log in if you already started — we'll send you a fresh code."
        proof={proof}
        footer={
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-azure-600 underline-offset-4 hover:underline">
              Log in
            </Link>
          </>
        }
      >
        <ButtonLink href="/signup" size="lg" className="w-full">
          Sign up
        </ButtonLink>
      </AuthShell>
    );
  }

  const masked = maskEmail(pending.email);

  return (
    <AuthShell
      title="Check your email"
      lede={`We sent a 6-digit code to ${masked}. Enter it below to finish creating your account.`}
      proof={proof}
      footer={
        <>
          Wrong address?{" "}
          <Link href="/signup" className="font-medium text-azure-600 underline-offset-4 hover:underline">
            Sign up again
          </Link>
        </>
      }
    >
      <VerifyEmailForm
        maskedEmail={masked}
        codeExpiresAt={pending.code_expires_at}
        resendAt={(pending.last_sent_at ?? 0) + RESEND_COOLDOWN_MS}
        codeActive={pending.code_hash !== null}
      />
    </AuthShell>
  );
}
