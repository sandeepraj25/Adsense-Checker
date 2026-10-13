"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastTone = "success" | "error" | "info";

type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
};

type ToastInput = {
  tone?: ToastTone;
  title: string;
  detail?: string;
  /** ms on screen. 0 keeps it until dismissed. */
  duration?: number;
};

type ToastApi = {
  toast: (input: ToastInput) => void;
  success: (title: string, detail?: string) => void;
  error: (title: string, detail?: string) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Toast surface for the whole app. Errors linger longer than
 * confirmations because they usually carry an instruction.
 */
const DEFAULT_MS: Record<ToastTone, number> = {
  success: 4000,
  info: 5000,
  error: 7000,
};

const MAX_VISIBLE = 3;

const tones: Record<
  ToastTone,
  { icon: typeof Check; text: string; ring: string; bg: string }
> = {
  success: {
    icon: Check,
    text: "text-mint-400",
    ring: "ring-mint-400/25",
    bg: "bg-mint-400/10",
  },
  error: {
    icon: AlertTriangle,
    text: "text-rose-400",
    ring: "ring-rose-400/25",
    bg: "bg-rose-400/10",
  },
  info: {
    icon: Info,
    text: "text-azure-400",
    ring: "ring-azure-400/25",
    bg: "bg-azure-400/10",
  },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ tone = "info", title, detail, duration }: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) =>
        [...current, { id, tone, title, detail }].slice(-MAX_VISIBLE),
      );

      const ms = duration ?? DEFAULT_MS[tone];
      if (ms > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms),
        );
      }
    },
    [dismiss],
  );

  // Clear pending timers if the tree unmounts mid-flight.
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (title, detail) => toast({ tone: "success", title, detail }),
      error: (title, detail) => toast({ tone: "error", title, detail }),
      dismiss,
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  const reduce = useReducedMotion();

  return (
    <div
      // Bottom-right on desktop, full-width bottom on phones where a
      // corner toast competes with the thumb zone.
      className={cn(
        "pointer-events-none fixed inset-x-3 bottom-3 z-[90] flex flex-col items-stretch gap-2",
        "sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[22rem] sm:items-end",
      )}
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const tone = tones[t.tone];
          const Icon = tone.icon;
          return (
            <motion.div
              key={t.id}
              layout={!reduce}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                "glass pointer-events-auto flex w-full items-start gap-3 rounded-xl p-3.5",
                "shadow-[0_12px_32px_-12px_rgba(24,24,27,0.25)]",
              )}
              role={t.tone === "error" ? "alert" : "status"}
            >
              <span
                className={cn(
                  "mt-px grid size-6 shrink-0 place-items-center rounded-full ring-1",
                  tone.bg,
                  tone.ring,
                  tone.text,
                )}
              >
                <Icon className="size-3.5" strokeWidth={2.4} />
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-[0.875rem] leading-snug font-medium text-cloud-50">
                  {t.title}
                </p>
                {t.detail ? (
                  <p className="mt-1 text-[0.8125rem] leading-snug text-cloud-400">
                    {t.detail}
                  </p>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                aria-label="Dismiss notification"
                className="-m-1 rounded-md p-1 text-cloud-600 transition-colors hover:text-cloud-200"
              >
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    throw new Error("useToast must be used inside a ToastProvider");
  }
  return api;
}
