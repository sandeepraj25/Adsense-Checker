import Image from "next/image";
import Link from "next/link";

import { Container } from "@/components/ui/Container";
import { UrlForm } from "@/components/ui/UrlForm";
import AdSenseLogo from "@/Image/Google-Adsense-Logo.png";

export function Hero() {
  return (
    <section id="top" className="relative pb-16 pt-32 sm:pb-20 sm:pt-36">
      <Container size="wide">
        <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14">
          <div>
            <p className="inline-flex items-center gap-2 text-[0.875rem] font-medium text-cloud-300">
              Pre-review checker for
              <Image
                src={AdSenseLogo}
                alt="Google AdSense"
                width={350}
                height={100}
                className="h-6 w-auto"
                priority
              />
            </p>

            <h1 className="t-display t-h1 mt-4 max-w-xl text-balance text-cloud-50">
              Is your website ready for AdSense?
            </h1>

            <p className="mt-5 max-w-lg text-[1.0625rem] leading-relaxed text-cloud-300">
              Scan your site for the issues that most often lead to a rejection — missing required
              pages, thin content, technical setup and policy signals — and get the exact fix for each.
            </p>

            <div className="mt-8 max-w-[34rem]">
              <UrlForm />
            </div>

            <p className="mt-4 text-[0.875rem] text-cloud-400">
              Free plan included.{" "}
              <Link href="/#process" className="font-medium text-azure-600 hover:text-azure-500">
                See how it works
              </Link>{" "}
              ·{" "}
              <Link href="/pricing" className="font-medium text-azure-600 hover:text-azure-500">
                Compare plans
              </Link>
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
            <video
              src="/video/adsense-video.mp4"
              autoPlay
              muted
              loop
              playsInline
              controls
              aria-label="Product walkthrough video"
              className="block aspect-video w-full object-cover"
            />
          </div>
        </div>
      </Container>
    </section>
  );
}
