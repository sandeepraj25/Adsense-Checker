import Link from "next/link";
import Image from "next/image";
import { Container } from "@/components/ui/Container";
import { AnalyticsChoicesButton } from "@/components/analytics/Tracker";

const columns = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "/#process" },
      { label: "What gets checked", href: "/#features" },
      { label: "Sample report", href: "/#report" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Rejection reasons", href: "/#guide-rejections" },
      { label: "Required pages guide", href: "/#guide-required-pages" },
      { label: "ads.txt reference", href: "/#guide-ads-txt" },
      { label: "Changelog", href: "/#top" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/#top" },
      { label: "Contact", href: "/#top" },
      { label: "Privacy", href: "/#top" },
      { label: "Terms", href: "/#top" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative border-t border-ink-700 bg-ink-900">
      <Container size="wide">
        <div className="grid grid-cols-2 gap-10 py-12 sm:grid-cols-3 lg:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div className="col-span-2 sm:col-span-3 lg:col-span-1">
            <Link href="/" aria-label="AdSense Checker home" className="inline-flex items-center">
              <Image
                src="/logo.png"
                alt="AdSense Checker"
                width={2078}
                height={757}
                sizes="140px"
                className="h-12 w-auto"
              />
            </Link>

            <p className="mt-4 max-w-sm text-[0.9375rem] leading-relaxed text-cloud-300">
              Check your website for potential AdSense approval issues before
              applying.
            </p>
          </div>

          {columns.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="text-[0.875rem] font-semibold text-cloud-50">
                {column.heading}
              </h2>

              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-[0.9375rem] text-cloud-300 transition-colors hover:text-cloud-50"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="flex flex-col gap-4 border-t border-ink-700 py-7 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.875rem] text-cloud-400">
            © {new Date().getFullYear()} All Rights Reserved.
            <span aria-hidden className="mx-2 text-ink-700">|</span>
            <AnalyticsChoicesButton className="text-cloud-400 underline decoration-ink-700 underline-offset-4 transition-colors hover:text-cloud-50" />
          </p>

          <p className="text-[0.875rem] text-cloud-400">
            Made by Sandeep -{" "}
            <a
              href="https://skillforever.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-cloud-300 underline decoration-ink-700 underline-offset-4 hover:text-cloud-50"
            >
              skillforever.com
            </a>
          </p>
        </div>
      </Container>
    </footer>
  );
}