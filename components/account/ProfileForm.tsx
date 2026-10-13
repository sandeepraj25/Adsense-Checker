"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Trash2 } from "lucide-react";

import { Avatar } from "@/components/account/Avatar";
import { Button } from "@/components/ui/Button";
import { Field, FormAlert } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { sessionChanged } from "@/lib/client-session";
import { validateName } from "@/lib/validate";

/**
 * Profile editor shared by the customer settings page and the admin
 * account page. The two differ only in which endpoints they call — and
 * those endpoints, not this component, decide who may change what.
 *
 * Choosing or removing a photo only stages the change and shows a
 * preview; nothing is sent until "Save changes", which applies the name
 * and the photo together and reports one result.
 */

export type ProfileEndpoints = {
  /** POST { name } */
  profile: string;
  /** POST multipart "avatar" to upload; DELETE to remove. */
  avatar: string;
};

export const CUSTOMER_PROFILE_ENDPOINTS: ProfileEndpoints = {
  profile: "/api/account/profile",
  avatar: "/api/account/avatar",
};

export const ADMIN_PROFILE_ENDPOINTS: ProfileEndpoints = {
  profile: "/api/admin/profile",
  avatar: "/api/admin/profile/avatar",
};

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

type PhotoChange =
  | { kind: "none" }
  | { kind: "upload"; file: File; preview: string }
  | { kind: "remove" };

type Failure = { message?: string; fields?: Record<string, string> } | null;

export function ProfileForm({
  name: savedName,
  email,
  avatarUrl: savedAvatar,
  endpoints = CUSTOMER_PROFILE_ENDPOINTS,
}: {
  name: string;
  email: string;
  avatarUrl?: string | null;
  endpoints?: ProfileEndpoints;
}) {
  const router = useRouter();
  const { success } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(savedName);
  const [photo, setPhoto] = useState<PhotoChange>({ kind: "none" });
  const [nameError, setNameError] = useState<string | undefined>();
  const [photoError, setPhotoError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Release the preview's object URL when it is replaced or unmounted.
  useEffect(() => {
    if (photo.kind !== "upload") return;
    const url = photo.preview;
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const nameDirty = name.trim() !== savedName.trim();
  const photoDirty = photo.kind !== "none";
  const dirty = nameDirty || photoDirty;

  const shownAvatar =
    photo.kind === "upload" ? photo.preview : photo.kind === "remove" ? null : savedAvatar;
  const hasPhoto = Boolean(shownAvatar);

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow choosing the same file again
    setSaved(false);
    if (!file) return;

    // A convenience pre-check only — the server re-validates the bytes.
    if (!ACCEPT.includes(file.type)) {
      setPhotoError("Use a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setPhotoError("That photo is larger than 5 MB. Choose a smaller one.");
      return;
    }
    setPhotoError(undefined);
    setPhoto({ kind: "upload", file, preview: URL.createObjectURL(file) });
  }

  function remove() {
    setSaved(false);
    setPhotoError(undefined);
    setPhoto(savedAvatar ? { kind: "remove" } : { kind: "none" });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;

    const problem = nameDirty ? validateName(name) : null;
    if (problem) {
      setNameError(problem);
      return;
    }

    setBusy(true);
    setSaved(false);
    setNameError(undefined);
    setPhotoError(undefined);
    setFormError(undefined);

    try {
      if (photo.kind === "upload") {
        const form = new FormData();
        form.append("avatar", photo.file);
        const res = await fetch(endpoints.avatar, { method: "POST", body: form });
        if (!res.ok) {
          const failure = (await res.json().catch(() => null)) as Failure;
          setPhotoError(failure?.fields?.avatar ?? failure?.message ?? "The photo did not upload.");
          setBusy(false);
          return;
        }
      } else if (photo.kind === "remove") {
        const res = await fetch(endpoints.avatar, { method: "DELETE" });
        if (!res.ok) {
          const failure = (await res.json().catch(() => null)) as Failure;
          setPhotoError(failure?.message ?? "The photo was not removed.");
          setBusy(false);
          return;
        }
      }

      if (nameDirty) {
        const res = await fetch(endpoints.profile, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        });
        if (!res.ok) {
          const failure = (await res.json().catch(() => null)) as Failure;
          if (failure?.fields?.name) setNameError(failure.fields.name);
          else setFormError(failure?.message ?? "Your name did not save.");
          // A photo change above already succeeded; reflect it.
          if (photoDirty) {
            setPhoto({ kind: "none" });
            router.refresh();
            sessionChanged();
          }
          setBusy(false);
          return;
        }
      }

      setPhoto({ kind: "none" });
      setSaved(true);
      setBusy(false);
      success("Profile updated");
      // Server components (sidebar, headings) re-render with the new
      // values; client navbars re-read the session.
      router.refresh();
      sessionChanged();
    } catch {
      setFormError("We could not reach the server. Nothing was changed.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {formError ? <FormAlert>{formError}</FormAlert> : null}

      {/* Photo */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar name={name || savedName} src={shownAvatar} size="lg" />

        <div className="min-w-0">
          <p className="text-[0.9375rem] font-medium text-cloud-50">Profile photo</p>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-cloud-400">
            JPEG, PNG or WebP, up to 5 MB. It is cropped to a square.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT.join(",")}
              onChange={pick}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <ImageUp className="size-4" aria-hidden />
              {hasPhoto ? "Change photo" : "Upload photo"}
            </Button>
            {hasPhoto ? (
              <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={remove}>
                <Trash2 className="size-4" aria-hidden />
                Remove
              </Button>
            ) : null}
            {photo.kind !== "none" && !busy ? (
              <Button
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => {
                  setPhoto({ kind: "none" });
                  setPhotoError(undefined);
                }}
              >
                Undo
              </Button>
            ) : null}
          </div>

          {photo.kind === "upload" ? (
            <p className="mt-2 text-[0.8125rem] text-azure-600">Preview — save to apply.</p>
          ) : photo.kind === "remove" ? (
            <p className="mt-2 text-[0.8125rem] text-azure-600">Photo will be removed when you save.</p>
          ) : null}
          {photoError ? (
            <p role="alert" className="mt-2 text-[0.8125rem] text-rose-400">
              {photoError}
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Display name"
          name="name"
          autoComplete="name"
          value={name}
          maxLength={80}
          error={nameError}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
            if (nameError) setNameError(undefined);
          }}
        />

        <Field
          label="Email"
          name="email"
          type="email"
          mono
          value={email}
          readOnly
          disabled
          hint="Your email is your login and appears on invoices. It cannot be changed here."
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="md" disabled={busy || !dirty} aria-busy={busy}>
          {busy ? (
            <>
              <Spinner />
              Saving
            </>
          ) : (
            "Save changes"
          )}
        </Button>
        <span aria-live="polite" className="text-[0.8125rem]">
          {saved && !dirty ? (
            <span className="text-mint-400">Saved</span>
          ) : dirty && !busy ? (
            <span className="text-cloud-400">Unsaved changes</span>
          ) : null}
        </span>
      </div>
    </form>
  );
}
