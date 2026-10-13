"use client";

import { Component } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Keeps a failed report from taking the range picker and tabs with it:
 * only the tab's content is replaced by an error, and choosing another
 * range or tab (which remounts this boundary) tries again.
 */
export class TabErrorBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="glass flex gap-3 rounded-xl px-5 py-5">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-400" aria-hidden />
        <div>
          <p className="font-semibold text-cloud-50">This section couldn&apos;t be loaded</p>
          <p className="mt-1 text-[0.875rem] leading-relaxed text-cloud-400">
            The analytics query failed; the rest of the site is unaffected. Reload the page, or pick a shorter range or another tab.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 inline-flex h-8 items-center rounded-md border border-ink-700 bg-white px-3 text-[0.8125rem] font-medium text-cloud-100 hover:text-cloud-50"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
