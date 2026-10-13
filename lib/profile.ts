import type { NextResponse } from "next/server";

import {
  AvatarError,
  AVATAR_MAX_BYTES,
  deleteAvatar,
  processAvatar,
  saveAvatar,
} from "@/lib/avatars";
import { setUserAvatarKey, updateUserName } from "@/lib/db/accounts";
import { avatarUrlFor, type User } from "@/lib/db/types";
import { accountBlock } from "@/lib/entitlement";
import {
  jsonError,
  jsonOk,
  jsonServerError,
  readJson,
  str,
  type ApiFailure,
} from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { validateName } from "@/lib/validate";

/**
 * Self-service profile changes, shared by /api/account/* (customers) and
 * /api/admin/profile/* (administrators).
 *
 * Every function takes the already-authenticated caller and changes only
 * that caller's row. There is no target-id parameter anywhere in this
 * module, so no request body can redirect an edit to another account.
 * Only `name` is read from a body — role, status, email, plan and every
 * other column are unreachable from here (no mass assignment).
 */

function guard(user: User, bucket: string): NextResponse<ApiFailure> | null {
  const blocked = accountBlock(user);
  if (blocked) return jsonError(blocked.code, blocked.message);

  const limit = rateLimit(`${bucket}:${user.id}`, 20, 10 * 60 * 1000);
  if (!limit.ok) {
    return jsonError(
      "RATE_LIMITED",
      `Too many changes. Try again in ${limit.retryAfterSeconds} seconds.`,
    );
  }
  return null;
}

export async function updateOwnName(user: User, request: Request) {
  const refused = guard(user, "profile");
  if (refused) return refused;

  const body = await readJson(request);
  if (!body) return jsonError("VALIDATION_ERROR", "Send a JSON body.");

  const name = str(body.name).trim();
  const problem = validateName(name);
  if (problem) {
    return jsonError("VALIDATION_ERROR", problem, { fields: { name: problem } });
  }

  updateUserName(user.id, name);
  return jsonOk({ name });
}

export async function uploadOwnAvatar(user: User, request: Request) {
  const refused = guard(user, "avatar");
  if (refused) return refused;

  // Refuse an oversized body before buffering it, when the client says
  // how big it is. The byte check after parsing is the real limit.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > AVATAR_MAX_BYTES + 64 * 1024) {
    return jsonError("VALIDATION_ERROR", "That photo is larger than 5 MB. Choose a smaller one.", {
      status: 413,
      fields: { avatar: "Maximum size is 5 MB" },
    });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("avatar");
    file = value instanceof File ? value : null;
  } catch {
    return jsonError("VALIDATION_ERROR", "Send the photo as a form upload named “avatar”.");
  }
  if (!file) {
    return jsonError("VALIDATION_ERROR", "Choose a photo to upload.", {
      fields: { avatar: "Choose a photo" },
    });
  }

  if (file.size > AVATAR_MAX_BYTES) {
    return jsonError("VALIDATION_ERROR", "That photo is larger than 5 MB. Choose a smaller one.", {
      status: 413,
      fields: { avatar: "Maximum size is 5 MB" },
    });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cleaned = await processAvatar(bytes);
    const key = await saveAvatar(cleaned);
    const previous = setUserAvatarKey(user.id, key);
    await deleteAvatar(previous);
    return jsonOk({ avatarUrl: avatarUrlFor(key) });
  } catch (error) {
    if (error instanceof AvatarError) {
      return jsonError("VALIDATION_ERROR", error.message, {
        fields: { avatar: error.message },
      });
    }
    return jsonServerError("profile/avatar", error);
  }
}

export async function removeOwnAvatar(user: User) {
  const refused = guard(user, "avatar");
  if (refused) return refused;

  const previous = setUserAvatarKey(user.id, null);
  await deleteAvatar(previous);
  return jsonOk({ avatarUrl: null });
}
