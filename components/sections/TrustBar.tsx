"use client";

import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

const platforms = [
  { name: "Wix", logo: "https://cdn.simpleicons.org/wix" },
  { name: "WordPress", logo: "https://cdn.simpleicons.org/wordpress" },
  { name: "Webflow", logo: "https://cdn.simpleicons.org/webflow" },
  { name: "Squarespace", logo: "https://cdn.simpleicons.org/squarespace" },
  { name: "Shopify", logo: "https://cdn.simpleicons.org/shopify" },
  { name: "Framer", logo: "https://cdn.simpleicons.org/framer" },
  {
    name: "Hostinger Website Builder",
    logo: "https://cdn.simpleicons.org/hostinger",
  },
  { name: "Elementor", logo: "https://cdn.simpleicons.org/elementor" },
  { name: "Blogger", logo: "https://cdn.simpleicons.org/blogger" },
  { name: "PHP", logo: "https://cdn.simpleicons.org/php" },
  { name: "Node.js", logo: "https://cdn.simpleicons.org/nodedotjs" },
];

export function TrustBar() {
  // Double the list for seamless infinite scrolling
  const marqueePlatforms = [...platforms, ...platforms];

  return (
    <section className="relative overflow-hidden border-y border-ink-700 bg-ink-900 py-6">
      <Container size="wide">
        <div className="flex flex-col items-center gap-4 lg:flex-row lg:gap-12">
          {/* TITLE */}
          <Reveal className="shrink-0">
            <h2 className="text-center text-[1rem] font-semibold leading-snug text-cloud-50 lg:max-w-[10rem] lg:text-left">
              Works with sites built on
            </h2>
          </Reveal>

          {/* MOVING LOGOS */}
          <Reveal delay={0.1} className="w-full overflow-hidden">
            <div className="relative w-full">
              {/* LEFT FADE */}
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-ink-900 via-ink-900/80 to-transparent sm:w-20" />

              {/* RIGHT FADE */}
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-ink-900 via-ink-900/80 to-transparent sm:w-20" />

              {/* LOGO ANIMATION */}
              <div className="flex w-max animate-platform-marquee items-center gap-6 py-2 sm:gap-8">
                {marqueePlatforms.map((platform, index) => (
                  <div
                    key={`${platform.name}-${index}`}
                    className="flex h-14 w-20 shrink-0 items-center justify-center"
                    title={platform.name}
                    aria-label={platform.name}
                  >
                    <img
                      src={platform.logo}
                      alt={platform.name}
                      className="h-9 w-9 object-contain"
                    />
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}