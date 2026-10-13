import { AlertTriangle, Check, X } from "lucide-react";
import type { Status } from "@/lib/checks";
import { cn } from "@/lib/cn";

/**
 * Semantic colour lives only on status — the brand gradient stays
 * reserved for brand moments, so verdicts read instantly.
 */
export const statusTheme: Record<
  Status,
  { text: string; bg: string; dot: string; ring: string; word: string }
> = {
  pass: {
    text: "text-mint-400",
    bg: "bg-mint-400/10",
    dot: "bg-mint-400",
    ring: "ring-mint-400/25",
    word: "Pass",
  },
  warn: {
    text: "text-amber-400",
    bg: "bg-amber-400/10",
    dot: "bg-amber-400",
    ring: "ring-amber-400/25",
    word: "Fix",
  },
  fail: {
    text: "text-rose-400",
    bg: "bg-rose-400/10",
    dot: "bg-rose-400",
    ring: "ring-rose-400/25",
    word: "Blocker",
  },
};

const icons: Record<Status, typeof Check> = {
  pass: Check,
  warn: AlertTriangle,
  fail: X,
};

export function StatusIcon({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  const Icon = icons[status];
  const theme = statusTheme[status];
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-full ring-1",
        theme.bg,
        theme.ring,
        theme.text,
        className,
      )}
    >
      <Icon className="size-3" strokeWidth={3} aria-hidden />
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  const theme = statusTheme[status];
  return (
    <span
      className={cn(
        "t-data rounded-md px-2 py-0.5 text-[0.75rem] font-medium ring-1",
        theme.bg,
        theme.ring,
        theme.text,
      )}
    >
      {theme.word}
    </span>
  );
}
