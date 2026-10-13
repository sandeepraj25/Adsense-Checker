import { cn } from "@/lib/cn";

/**
 * Subtle glass panel. `lit` adds the top edge highlight; `hairline`
 * adds the gradient 1px border for panels that need to feel primary.
 */
export function GlassCard({
  children,
  className,
  lit = false,
  hairline = false,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  lit?: boolean;
  hairline?: boolean;
  as?: "div" | "article" | "li";
}) {
  return (
    <Tag
      className={cn(
        "glass relative overflow-hidden rounded-xl",
        lit && "edge-light",
        hairline && "grad-hairline",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
