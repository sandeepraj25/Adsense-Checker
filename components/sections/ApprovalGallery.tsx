import Image from "next/image";

import { Container } from "@/components/ui/Container";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Reveal } from "@/components/ui/Reveal";

const approvals = [
  "adsense1.jpeg",
  "adsense2.png",
  "adsense3.webp",
  "adsense4.webp",
  "adsense5.png",
  "adsense6.jpg",
  "adsense7.jpg",
  "adsense8.jpeg",
  "adsense9.png",
  "adsense10.PNG",
];

export function ApprovalGallery() {
  return (
    <section
      id="approval-gallery"
      className="relative scroll-mt-24 border-t border-ink-700 py-16 sm:py-20"
    >
      <Container size="wide">
        <SectionHeader
          eyebrow="Success stories"
          title="Approvals from site owners"
          lede="Screenshots of AdSense approval emails shared by website owners."
        />

        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {approvals.map((image, i) => (
            <Reveal key={image} delay={i * 0.05}>
              <div className="group relative overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
                <div className="relative aspect-video w-full">
                  <Image
                    src={`/video/approval/${image}`}
                    alt={`AdSense success story ${i + 1}`}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                    className="object-cover"
                  />
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        <p className="mt-8 text-[0.9375rem] text-cloud-400">
          Video reviews from customers are on the way and will appear here.
        </p>
      </Container>
    </section>
  );
}