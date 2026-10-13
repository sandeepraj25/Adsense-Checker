import { Container } from "@/components/ui/Container";
import { UrlForm } from "@/components/ui/UrlForm";

export function FinalCta() {
  return (
    <section className="border-t border-ink-700 bg-ink-900 py-16 sm:py-20">
      <Container size="narrow">
        <div className="text-center">
          <h2 className="t-display t-h2 text-balance text-cloud-50">Check your website before you apply</h2>
          <p className="mx-auto mt-3 max-w-md text-[1rem] leading-relaxed text-cloud-300">
            One scan shows the blockers a reviewer would find, and how to fix each one.
          </p>
        </div>

        <div className="mx-auto mt-8 max-w-xl">
          <UrlForm cta="Check My Website" />
        </div>
      </Container>
    </section>
  );
}
