"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Prints the current page. The invoice is already a document, so the
 * browser's own PDF export is the download — no generator, no dependency,
 * and what you see is exactly what you get.
 */
export function PrintButton({ label = "Download" }: { label?: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="no-print"
      onClick={() => window.print()}
    >
      <Printer className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}
