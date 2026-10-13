"use client";

import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Eraser,
  KeyRound,
  Power,
  Copy,
  Eye,
  ShieldCheck,
  Box,
  Globe2,
} from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Field, FormAlert } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";

export type GatewayFormState = {
  id: string;
  label: string;
  blurb: string;
  methods: string[];
  enabled: boolean;
  configured: boolean;
  environment: "live" | "sandbox";
  source: "database" | "environment" | "none";
  masked: Record<string, string>;
  missing: string[];
  updatedAt: number;
  updatedBy: string | null;
  webhookUrl: string;
  fields: {
    key: string;
    label: string;
    hint: string;
    secret: boolean;
    optional: boolean;
  }[];
};

const gatewayLogos: Record<string, string> = {
  razorpay: "/razorpay.png",
  cashfree: "/cashfree.png",
  paypal: "/paypal.png",
};

export function GatewayForm({
  gateway,
}: {
  gateway: GatewayFormState;
}) {
  const router = useRouter();
  const { success, error } = useToast();

  const [busy, setBusy] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const typed = Object.entries(values).filter(
    ([, value]) => value.trim().length > 0,
  );

  async function patch(
    key: string,
    body: Record<string, unknown>,
    done: string,
  ): Promise<boolean> {
    if (busy) return false;

    setBusy(key);

    try {
      const res = await fetch(`/api/admin/gateways/${gateway.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });

      const text = await res.text();

      let data: unknown = null;

      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        console.error("Gateway API returned invalid JSON:", text);
      }

      const payload = (data ?? {}) as {
        ok?: boolean;
        message?: string;
        changed?: string[];
      };

      if (!res.ok || !payload.ok) {
        console.error("Gateway API error:", {
          status: res.status,
          statusText: res.statusText,
          body: data ?? text,
        });

        error(
          "Not saved",
          payload.message ??
            `Server returned ${res.status} ${res.statusText}`,
        );

        return false;
      }

      success(
        done,
        payload.changed?.length
          ? payload.changed.join("; ")
          : undefined,
      );

      setValues({});
      router.refresh();

      return true;
    } catch (err) {
      console.error("Gateway request failed:", err);

      const message =
        err instanceof Error
          ? err.message
          : "Check your connection and server, then try again.";

      error("Could not reach the server", message);

      return false;
    } finally {
      setBusy(null);
    }
  }

  const working = (key: string) => busy === key;

  const logo = gatewayLogos[gateway.id];

  const copyWebhookUrl = async () => {
    try {
      await navigator.clipboard.writeText(gateway.webhookUrl);
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (err) {
      console.error("Webhook copy failed:", err);

      error(
        "Could not copy",
        "Please copy the webhook URL manually.",
      );
    }
  };

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-[24px] border bg-ink-900",
        "border-ink-700",
        "",
        gateway.enabled && "border-azure-500/25",
      )}
    >

      {/* HEADER */}
      <div className="relative flex flex-col gap-5 border-b border-ink-700 px-6 py-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {/* Gateway logo */}
          <div className="flex h-14 w-20 shrink-0 items-center justify-center sm:w-24">
            {logo ? (
              <Image
                src={logo}
                alt={`${gateway.label} logo`}
                width={110}
                height={60}
                className="h-full w-full object-contain"
              />
            ) : (
              <CreditCardFallback />
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-semibold tracking-tight text-cloud-50 sm:text-[28px]">
                {gateway.label}
              </h2>

              {gateway.enabled ? (
                <Badge
                  tone={
                    gateway.environment === "live"
                      ? "pass"
                      : "warn"
                  }
                  dot
                >
                  {gateway.environment === "live"
                    ? "Live"
                    : "Sandbox"}
                </Badge>
              ) : (
                <Badge tone="neutral">
                  {gateway.configured
                    ? "Disabled"
                    : "Not configured"}
                </Badge>
              )}

              {gateway.source === "environment" ? (
                <Badge tone="neutral">From environment</Badge>
              ) : null}
            </div>

            <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-cloud-300 sm:text-base">
              {gateway.blurb} Accepts {gateway.methods.join(", ")}.
            </p>
          </div>
        </div>

        <Button
          size="sm"
          variant="quiet"
          disabled={
            busy !== null ||
            (!gateway.enabled && !gateway.configured)
          }
          onClick={() =>
            void patch(
              "toggle",
              {
                enabled: !gateway.enabled,
              },
              gateway.enabled
                ? `${gateway.label} disabled`
                : `${gateway.label} enabled`,
            )
          }
          className="shrink-0"
        >
          {working("toggle") ? (
            <Spinner className="size-4" />
          ) : (
            <Power className="size-4" />
          )}

          {gateway.enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      {/* CONTENT */}
      <div className="relative space-y-6 px-6 py-6">
        {!gateway.configured ? (
          <div className="rounded-xl border border-azure-500/25 bg-azure-500/[0.05] p-4">
            <FormAlert tone="info">
              Not configured yet. Enter the credentials below, save, then
              enable it. Until at least one gateway is enabled, checkout is
              closed and customers are told so rather than being sent to a
              broken page.
            </FormAlert>
          </div>
        ) : null}

        {gateway.enabled && gateway.missing.length > 0 ? (
          <FormAlert>
            Enabled but incomplete: {gateway.missing.join(", ")}. Optional
            fields are optional for orders, but webhook verification cannot run
            without the webhook secret.
          </FormAlert>
        ) : null}

        {gateway.source === "environment" ? (
          <FormAlert tone="info">
            These credentials come from environment variables, not from this
            panel. Saving here stores them in the database and the database
            wins from then on; clearing a field here does not unset the
            environment variable behind it.
          </FormAlert>
        ) : null}

        {/* CREDENTIAL FIELDS */}
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {gateway.fields.map((field) => {
            const stored = gateway.masked[field.key];

            return (
              <div key={field.key}>
                <Field
                  label={field.label}
                  mono
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.key] ?? ""}
                  placeholder={
                    stored ??
                    (field.optional ? "Optional" : "Not set")
                  }
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                  hint={field.hint}
                />

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {stored ? (
                    <span className="t-data text-xs text-cloud-500">
                      stored: {stored}
                    </span>
                  ) : (
                    <span className="text-xs text-cloud-500">
                      {field.optional
                        ? "not set (optional)"
                        : "not set"}
                    </span>
                  )}

                  {stored ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void patch(
                          `clear-${field.key}`,
                          {
                            clear: [field.key],
                          },
                          `${field.label} removed`,
                        )
                      }
                      className="inline-flex items-center gap-1 text-xs text-rose-400 transition-colors hover:text-rose-300 disabled:opacity-50"
                    >
                      {working(`clear-${field.key}`) ? (
                        <Spinner className="size-3" />
                      ) : (
                        <Eraser className="size-3" />
                      )}

                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* ACTIONS */}
        <div className="flex flex-wrap items-center gap-3 border-t border-ink-700 pt-5">
          <Button
            size="sm"
            disabled={busy !== null || typed.length === 0}
            onClick={() =>
              void patch(
                "save",
                {
                  values: Object.fromEntries(typed),
                },
                `${gateway.label} credentials saved`,
              )
            }
          >
            {working("save") ? (
              <Spinner className="size-4" />
            ) : (
              <KeyRound className="size-4" />
            )}

            Save{" "}
            {typed.length > 0
              ? `${typed.length} field${
                  typed.length === 1 ? "" : "s"
                }`
              : "credentials"}
          </Button>

          <Button
            size="sm"
            variant={
              gateway.environment === "sandbox"
                ? "ghost"
                : "quiet"
            }
            disabled={
              busy !== null ||
              gateway.environment === "sandbox"
            }
            onClick={() =>
              void patch(
                "env-sandbox",
                {
                  environment: "sandbox",
                },
                `${gateway.label} switched to sandbox`,
              )
            }
          >
            {working("env-sandbox") ? (
              <Spinner className="size-4" />
            ) : (
              <Box className="size-4" />
            )}

            Use sandbox
          </Button>

          <Button
            size="sm"
            variant={
              gateway.environment === "live"
                ? "ghost"
                : "quiet"
            }
            disabled={
              busy !== null ||
              gateway.environment === "live"
            }
            onClick={() =>
              void patch(
                "env-live",
                {
                  environment: "live",
                },
                `${gateway.label} switched to live`,
              )
            }
          >
            {working("env-live") ? (
              <Spinner className="size-4" />
            ) : (
              <Globe2 className="size-4" />
            )}

            Use live
          </Button>
        </div>

        {/* WEBHOOK */}
        <div className="rounded-xl border border-ink-700 bg-ink-900 p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="t-eyebrow text-xs tracking-[0.18em] text-cloud-500">
                Webhook URL
              </p>

              <p className="t-data mt-2 break-all text-sm text-cloud-100 sm:text-base">
                {gateway.webhookUrl}
              </p>

              <p className="mt-3 max-w-4xl text-sm leading-relaxed text-cloud-500">
                Register this URL in the {gateway.label} dashboard. Every
                webhook is verified against the secret above before it is
                allowed to change a subscription, and a repeat delivery of the
                same event is ignored.
              </p>
            </div>

            <button
              type="button"
              onClick={copyWebhookUrl}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-azure-500/20 bg-azure-500/[0.07] px-4 py-2.5 text-sm font-medium text-azure-600 transition hover:bg-azure-500/[0.12]"
            >
              <Copy className="size-4" />

              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        {/* SECURITY */}
        <div className="flex items-start gap-3 rounded-xl border border-ink-700 bg-ink-900 p-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-azure-500/15 bg-azure-500/[0.08] text-azure-600">
            <ShieldCheck className="size-5" />
          </div>

          <p className="pt-0.5 text-sm leading-relaxed text-cloud-500">
            {gateway.updatedBy
              ? `Last changed by ${gateway.updatedBy}.`
              : "Never changed from this panel."}{" "}
            Secrets are encrypted before they are stored and are never returned
            by any endpoint — only the last four characters appear above.
          </p>
        </div>
      </div>
    </section>
  );
}

function CreditCardFallback() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-ink-700 bg-ink-900">
      <CreditCardIcon />
    </div>
  );
}

function CreditCardIcon() {
  return <CreditCardFallbackIcon />;
}

function CreditCardFallbackIcon() {
  return <Eye className="size-5 text-cloud-400" />;
}