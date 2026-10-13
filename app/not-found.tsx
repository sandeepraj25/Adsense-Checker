import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/Button";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-ink-900 px-4 py-16">
      <div className="glass edge-light relative w-full max-w-lg rounded-xl p-7 text-center sm:p-9">
        <Link href="/" aria-label="AdSense Checker home" className="inline-flex">
          <Image src="/logo.png" alt="AdSense Checker" width={2078} height={757} sizes="120px" className="h-10 w-auto" />
        </Link>

        <p className="t-display mt-7 text-[3.25rem] leading-none">
          <span className="grad-text">404</span>
        </p>

        <h1 className="t-h3 mt-4 text-cloud-50">This page does not exist</h1>

        <p className="mx-auto mt-3 max-w-sm text-[0.9375rem] leading-relaxed text-cloud-400">
          The link may be out of date, or the report you are looking for was
          deleted. Your reports are always listed in your dashboard.
        </p>

        <div className="mt-7 flex flex-wrap justify-center gap-2.5">
          <ButtonLink href="/" size="md">
            Back to homepage
          </ButtonLink>
          <ButtonLink href="/dashboard" size="md" variant="ghost">
            Go to dashboard
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
