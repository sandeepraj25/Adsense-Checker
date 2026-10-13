
"use client";

import { Container } from "@/components/ui/Container";

const platforms = [
    { name: "WordPress", src: "/logos/wordpress.svg" },
    { name: "Blogger", src: "/logos/blogger.png" },
    { name: "Wix", src: "/logos/wix.webp" },
    { name: "Shopify", src: "/logos/shopify_logo.webp" },
    { name: "Squarespace", src: "/logos/squarespace.webp" },
];

export default function PlatformMarquee() {
    return (
        <section className="w-full overflow-hidden border-y border-gray-100 bg-white py-5 sm:py-6">
            <Container size="wide">
                <div className="flex min-w-0 flex-col items-center gap-5 sm:gap-6 md:flex-row md:gap-8 lg:gap-10">
                    {/* Responsive heading */}
                    <div className="w-full min-w-0 shrink-0 text-center md:w-56 md:text-left lg:w-64 xl:w-72">
                        <p className="text-base font-bold leading-snug tracking-tight text-slate-900 sm:text-lg lg:text-xl">
                            Trusted by{" "}
                            <span className="font-serif font-normal italic text-indigo-600">
                                website owners
                            </span>{" "}
                            &amp; Businesses worldwide
                        </p>
                    </div>

                    {/* Responsive scrolling logos */}
                    <div className="relative w-full min-w-0 flex-1 overflow-hidden">
                        <div
                            className="platform-marquee flex w-max items-center"
                            role="group"
                            aria-label="Supported website platforms"
                        >
                            {[0, 1].map((copy) => (
                                <div
                                    key={copy}
                                    className="flex shrink-0 items-center gap-7 pr-7 sm:gap-10 sm:pr-10 lg:gap-12 lg:pr-12"
                                    aria-hidden={copy === 1}
                                >
                                    {platforms.map((platform) => (
                                        <div
                                            key={platform.name}
                                            className="flex h-9 w-24 shrink-0 items-center justify-center sm:h-10 sm:w-28 md:w-24 lg:w-28"
                                        >
                                            <img
                                                src={platform.src}
                                                alt={copy === 0 ? platform.name : ""}
                                                loading="lazy"
                                                draggable={false}
                                                className="max-h-7 max-w-full object-contain sm:max-h-8"
                                            />
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </Container>

            <style jsx>{`
                .platform-marquee {
                    animation: platform-scroll 22s linear infinite;
                    will-change: transform;
                }

                @keyframes platform-scroll {
                    from {
                        transform: translateX(0);
                    }
                    to {
                        transform: translateX(-50%);
                    }
                }

                @media (hover: hover) {
                    .platform-marquee:hover {
                        animation-play-state: paused;
                    }
                }

                @media (prefers-reduced-motion: reduce) {
                    .platform-marquee {
                        animation: none;
                        will-change: auto;
                    }
                }
            `}</style>
        </section>
    );
}
