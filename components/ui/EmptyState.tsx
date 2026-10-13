import { cn } from "@/lib/cn";
import { ButtonLink } from "./Button";

/**
 * The "nothing here yet" state. Deliberately not a sad grey box: a faint
 * dot field and a single soft glow keep it feeling like part of the
 * product rather than a dead end.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: { label: string; href: string };
  className?: string;
}) {
  return (
    <div
      className={cn(
        "glass relative overflow-hidden rounded-xl px-6 py-12 text-center",
        className,
      )}
    >
      <div className="relative mx-auto max-w-sm">
        {icon ? (
          <div className="mx-auto mb-5 grid size-12 place-items-center rounded-xl border border-ink-700 bg-ink-900 text-azure-600">
            {icon}
          </div>
        ) : null}

        <h3 className="t-h3 text-cloud-50">{title}</h3>
        {body ? (
          <p className="mx-auto mt-2.5 max-w-[34ch] text-[0.9375rem] leading-relaxed text-cloud-400">
            {body}
          </p>
        ) : null}

        {action ? (
          <div className="mt-6 flex justify-center">
            <ButtonLink href={action.href} size="md">
              {action.label}
            </ButtonLink>
          </div>
        ) : null}
      </div>
    </div>
  );
}
