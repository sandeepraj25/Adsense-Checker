"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "quiet";
type Size = "sm" | "md" | "lg";

const base =
  "group relative inline-flex items-center justify-center gap-2 rounded-xl font-medium " +
  "transition-colors duration-200 " +
  "disabled:cursor-not-allowed disabled:opacity-55";

const variants: Record<Variant, string> = {
  /* The one solid element on a surface. Flat indigo, a hairline shadow —
     no glow, no lift: the colour already carries the emphasis. */
  primary:
    "bg-azure-500 text-white shadow-[0_1px_2px_rgba(24,24,27,0.12)] " +
    "hover:bg-azure-600 active:bg-azure-600",
  ghost:
    "border border-ink-700 bg-white text-cloud-50 shadow-[0_1px_2px_rgba(24,24,27,0.04)] " +
    "hover:border-zinc-300 hover:bg-ink-900",
  quiet:
    "text-cloud-300 hover:text-cloud-50 hover:bg-ink-800 border border-transparent",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-[0.8125rem]",
  md: "h-11 px-5 text-[0.9375rem]",
  lg: "h-[3.25rem] px-6 text-[0.9375rem]",
};

type CommonProps = {
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  className?: string;
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  className,
  ...rest
}: CommonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  href,
  variant = "primary",
  size = "md",
  className,
  onClick,
}: CommonProps & { href: string; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(base, variants[variant], sizes[size], className)}
    >
      {children}
    </Link>
  );
}
