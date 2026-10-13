
import Image from "next/image";

import { Container } from "@/components/ui/Container";
import { Reveal } from "@/components/ui/Reveal";

const teamMembers = [
  {
    name: "Gungun",
    designation: "UI/UX Designer",
    image: "/team/member-3.png",
  },
  {
    name: "Sandeep Raj",
    designation: "Full-Stack Engineer",
    image: "/team/member-1.png",
  },
  {
    name: "Roshan Kumar",
    designation: "AI Engineer",
    image: "/team/member-2.png",
  },
];

export function Team() {
  return (
    <section
      id="team"
      className="relative pt-16 pb-8 sm:pt-20 sm:pb-124"
    >
      <Container size="wide" className="relative">
        {/* Section Header */}
        <Reveal>
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="t-display t-h2 mt-18 text-cloud-50">
              The Team Behind AdSense Checker
            </h1>

            <p className="mx-auto mt-3 max-w-lg text-base leading-relaxed text-cloud-300">
              Meet the people building and improving AdSense Checker.
            </p>
          </div>
        </Reveal>

        {/* Team Cards */}
        <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-5 sm:grid-cols-3 sm:gap-6">
          {teamMembers.map((member, index) => (
            <Reveal key={member.name} delay={index * 0.08}>
              <article className="h-full overflow-hidden rounded-xl border border-ink-700 bg-white transition-shadow duration-300 hover:shadow-lg">
                <div className="relative aspect-[4/3] overflow-hidden bg-ink-850 sm:aspect-[4/5]">
                  <Image
                    src={member.image}
                    alt={member.name}
                    fill
                    className="object-cover object-center transition-transform duration-500 hover:scale-105"
                    sizes="(max-width: 639px) 100vw, (max-width: 1023px) 33vw, 320px"
                  />
                </div>

                <div className="border-t border-ink-700 px-4 py-4 sm:px-5">
                  <h2 className="text-lg font-semibold text-cloud-50">
                    {member.name}
                  </h2>

                  <p className="mt-1 text-sm text-cloud-300">
                    {member.designation}
                  </p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
