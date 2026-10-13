import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The two shapes every admin page is built from: a titled panel, and a
 * table that stays readable on a phone. Both are plain server components
 * — the panel is chrome, and putting chrome in a client bundle for no
 * interaction would be wasteful.
 */
export function Panel({
  title,
  description,
  action,
  children,
  className,
  id,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("glass rounded-xl", className)}>
      <div className="flex flex-col gap-3 border-b border-ink-700 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[1rem] font-semibold text-cloud-50">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-[0.8125rem] leading-relaxed text-cloud-400">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/**
 * A horizontally scrollable table. Admin tables carry more columns than a
 * phone can show, and scrolling the table beats hiding columns that
 * someone came to the panel specifically to read.
 */
export function TableShell({
  head,
  children,
  className,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("-mx-5 overflow-x-auto px-5", className)}>
      <table className="w-full min-w-[46rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink-700">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "t-eyebrow px-3 py-2.5 text-[0.75rem] font-semibold tracking-[0.12em] whitespace-nowrap text-cloud-400 first:pl-0 last:pr-0",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  mono = false,
}: {
  children?: React.ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-3 py-3 align-middle text-[0.875rem] text-cloud-200 first:pl-0 last:pr-0",
        mono && "t-data text-[0.8125rem]",
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <tr
      className={cn(
        "border-b border-ink-850 transition-colors last:border-0 hover:bg-ink-900",
        className,
      )}
    >
      {children}
    </tr>
  );
}

/** A filter row rendered as links, so filters survive a page reload. */
export function FilterTabs({
  options,
  current,
  className,
}: {
  options: { label: string; href: string; value: string; count?: number }[];
  current: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((option) => {
        const active = option.value === current;
        return (
          <Link
            key={option.value}
            href={option.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-md border px-2.5 text-[0.8125rem] font-medium transition-colors",
              active
                ? "border-azure-500/30 bg-azure-500/[0.07] text-azure-600"
                : "border-ink-700 bg-white text-cloud-300 hover:border-zinc-300 hover:text-cloud-50",
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="t-data ml-1.5 text-[0.75rem] font-normal text-cloud-400">
                {option.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

/** "Nothing matched" inside a panel — lighter than the full EmptyState. */
export function NoRows({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-10 text-center text-[0.875rem] text-cloud-400">{children}</p>
  );
}

/** A labelled set of filter links, for panels with more than one filter. */
export function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <p className="w-28 shrink-0 text-[0.8125rem] font-medium text-cloud-400">{label}</p>
      {children}
    </div>
  );
}

/** The row of compact metric tiles at the top of a page. */
export function StatGrid({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>
  );
}
