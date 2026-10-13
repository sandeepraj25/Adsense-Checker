import { requireAdminApi } from "@/lib/auth/guard";
import { recordAdminAction } from "@/lib/db/admin";
import { isGatewayId, type GatewayEnvironment } from "@/lib/db/types";
import {
  bool,
  jsonError,
  jsonOk,
  jsonServerError,
  readJson,
  str,
  strList,
} from "@/lib/http";
import {
  gatewayFor,
  gatewayView,
  saveGatewayCredentials,
} from "@/lib/payments";

export const runtime = "nodejs";

/**
 * Payment gateway credentials.
 *
 * What comes back is always the masked view — the last four characters of
 * each secret and nothing more. Secrets go in and never come out: there
 * is no endpoint, admin or otherwise, that returns a stored key, because
 * a panel that can display a key is a panel that leaks every key the
 * moment one admin session is stolen. Answering "did the right key get
 * saved?" needs four characters, not the key.
 *
 * A field left empty is treated as "I did not retype this one" and the
 * stored value is kept. Clearing is deliberate and separate, via `clear`.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const admin = { id: guard.admin.id, email: guard.admin.email };

  const { id } = await context.params;
  if (!isGatewayId(id)) return jsonError("NOT_FOUND", "No such payment gateway.");
  const gateway = gatewayFor(id);
  if (!gateway) return jsonError("NOT_FOUND", "No such payment gateway.");

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  try {
    // Only the fields this gateway declares are read. An unexpected key in
    // the body is ignored rather than stored, so the credential bag cannot
    // be used as free-form storage.
    const values: Record<string, string> = {};
    const submitted = body.values;
    if (submitted && typeof submitted === "object" && !Array.isArray(submitted)) {
      const bag = submitted as Record<string, unknown>;
      for (const field of gateway.fields) {
        const value = str(bag[field.key]).trim();
        if (value) values[field.key] = value;
      }
    }

    const clear = (strList(body.clear) ?? []).filter((key) =>
      gateway.fields.some((field) => field.key === key),
    );

    const environmentRaw = str(body.environment);
    if (environmentRaw && environmentRaw !== "live" && environmentRaw !== "sandbox") {
      return jsonError("VALIDATION_ERROR", "Environment must be live or sandbox.");
    }
    const environment: GatewayEnvironment | null =
      environmentRaw === "live" || environmentRaw === "sandbox" ? environmentRaw : null;
    const enabled = bool(body.enabled);

    const before = gatewayView(id);
    const result = saveGatewayCredentials({
      id,
      values,
      clear,
      ...(environment ? { environment } : {}),
      ...(enabled !== null ? { enabled } : {}),
      actorEmail: admin.email,
    });

    if (!result.ok) return jsonError("VALIDATION_ERROR", result.message);

    if (result.changed.length > 0) {
      // The detail line names which fields moved. It never contains a
      // value — an audit log that quotes the secret it is recording the
      // change to defeats encrypting the column in the first place.
      const credentialFields = result.changed.filter(
        (note) => note !== "enabled" && note !== "disabled" && !note.startsWith("environment"),
      );
      recordAdminAction({
        admin,
        action:
          before && before.enabled !== result.view.enabled
            ? result.view.enabled
              ? "gateway.enabled"
              : "gateway.disabled"
            : credentialFields.length > 0
              ? "gateway.credentials_updated"
              : "gateway.updated",
        targetType: "gateway",
        targetId: id,
        targetLabel: gateway.label,
        detail: result.changed.join("; "),
      });
    }

    return jsonOk({ gateway: result.view, changed: result.changed });
  } catch (error) {
    return jsonServerError("admin/gateways/patch", error);
  }
}

/** The masked view of one gateway. Never the credentials themselves. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const { id } = await context.params;
  const view = gatewayView(id);
  if (!view) return jsonError("NOT_FOUND", "No such payment gateway.");
  return jsonOk({ gateway: view });
}
