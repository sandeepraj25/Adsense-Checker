import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { AVATAR_DIR } from "@/lib/env";
import { AVATAR_KEY_PATTERN } from "@/lib/db/types";

/**
 * Profile-photo storage.
 *
 * Where: `AVATAR_DIR`, defaulting to `<DATA_DIR>/avatars` — the same disk
 * that already holds the SQLite database. On Render that disk must be a
 * persistent disk anyway (otherwise every deploy would wipe the users
 * table), so photos survive restarts and redeploys for exactly the same
 * reason accounts do. Nothing is written to the app's build directory or
 * to `public/`, which are replaced on every deploy.
 *
 * What: never the upload itself. Every image is decoded, checked, cropped
 * to a 256×256 square and re-encoded as WebP. Re-encoding throws away
 * anything that is not pixels — EXIF (including GPS position), embedded
 * profiles, trailing polyglot payloads — so the stored file is always a
 * small, clean image regardless of what was sent.
 *
 * How it is named: 18 random bytes (base64url, 24 chars) + ".webp". The
 * name is generated here and validated against one strict pattern on the
 * way back in, so a request can never steer a path (`../`, absolute paths,
 * other extensions) and a photo URL cannot be guessed.
 */

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_SIZE = 256;
/** Refuse decompression bombs: a tiny file that inflates to gigapixels. */
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 10_000;
const MIN_EDGE = 32;

export const AVATAR_ACCEPT = ["image/jpeg", "image/png", "image/webp"] as const;

export function avatarDir(): string {
  const dir = AVATAR_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export class AvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarError";
  }
}

type Sniffed = "jpeg" | "png" | "webp";

/**
 * Identifies the format from the file's own first bytes. The filename and
 * the browser-supplied MIME type are both attacker-controlled, so neither
 * is consulted. SVG, GIF, HEIC, PDF, executables and everything else fail
 * here, before any decoder sees them.
 */
export function sniffImage(bytes: Uint8Array): Sniffed | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "png";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

type SharpModule = typeof import("sharp");

/**
 * Loaded lazily so a machine that has not run `npm install` since sharp
 * was added still serves every other page — only the upload reports a
 * clear error.
 */
async function loadSharp(): Promise<SharpModule> {
  try {
    const mod = (await import("sharp")) as unknown as { default?: SharpModule };
    return (mod.default ?? (mod as unknown as SharpModule));
  } catch {
    throw new AvatarError(
      "Photo uploads are not available on this server yet. Run `npm install` and restart.",
    );
  }
}

/** Validates an upload and returns the cleaned 256×256 WebP. */
export async function processAvatar(input: Uint8Array): Promise<Buffer> {
  if (input.byteLength === 0) throw new AvatarError("That file is empty.");
  if (input.byteLength > AVATAR_MAX_BYTES) {
    throw new AvatarError("That photo is larger than 5 MB. Choose a smaller one.");
  }

  const sniffed = sniffImage(input);
  if (!sniffed) {
    throw new AvatarError("Use a JPEG, PNG or WebP image. Other file types are not accepted.");
  }

  const sharp = await loadSharp();
  const decoder = () =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });

  let format: string | undefined;
  let width = 0;
  let height = 0;
  try {
    const meta = await decoder().metadata();
    format = meta.format;
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    throw new AvatarError("That image could not be read. It may be damaged — try another file.");
  }

  // The decoder must agree with the magic bytes. A PNG header glued to
  // something else is refused rather than "repaired".
  if (format !== sniffed) {
    throw new AvatarError("That image could not be read. It may be damaged — try another file.");
  }
  if (width < MIN_EDGE || height < MIN_EDGE) {
    throw new AvatarError(`Choose a photo at least ${MIN_EDGE}×${MIN_EDGE} pixels.`);
  }
  if (width > MAX_EDGE || height > MAX_EDGE) {
    throw new AvatarError("That photo's dimensions are too large. Choose a smaller image.");
  }

  try {
    return await decoder()
      .rotate() // honour the camera's orientation before EXIF is dropped
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "attention" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AvatarError("That image could not be processed. Try another file.");
  }
}

function newAvatarKey(): string {
  return `${randomBytes(18).toString("base64url")}.webp`;
}

/** Resolves a key to its file, or null if the key is not one we issue. */
function fileFor(key: string): string | null {
  if (!AVATAR_KEY_PATTERN.test(key)) return null;
  const dir = avatarDir();
  const file = path.join(dir, key);
  // Belt and braces: the pattern already excludes separators and dots.
  return path.dirname(file) === dir ? file : null;
}

/** Writes a processed image and returns its new key. Atomic: temp + rename. */
export async function saveAvatar(webp: Buffer): Promise<string> {
  const key = newAvatarKey();
  const file = fileFor(key);
  if (!file) throw new Error("generated avatar key failed validation");
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, webp, { mode: 0o600, flag: "wx" });
  await rename(temp, file);
  return key;
}

export async function readAvatar(key: string): Promise<Buffer | null> {
  const file = fileFor(key);
  if (!file) return null;
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Best effort: a missing file is already the desired outcome. */
export async function deleteAvatar(key: string | null | undefined): Promise<void> {
  if (!key) return;
  const file = fileFor(key);
  if (!file) return;
  try {
    await unlink(file);
  } catch {
    /* already gone */
  }
}
