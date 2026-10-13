/**
 * The public origin a browser used to reach us.
 *
 * Deliberately free of node builtins so middleware.ts (edge runtime) can
 * share it with route handlers — one definition of "our origin" for both
 * the CSRF check and the checkout return URL.
 *
 * `request.nextUrl.origin` can be the internal origin in a reverse-proxy
 * deployment, while the browser's Origin uses the public host, so the
 * forwarded host wins when present, then the ordinary Host header.
 */
export function requestOrigin(headers: Headers, url: string | URL): string {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? parsed.host;
  const protocol =
    headers.get("x-forwarded-proto") ?? parsed.protocol.replace(/:$/, "");
  return `${protocol}://${host}`;
}

/** Request header middleware uses to tell server components the path. */
export const PATH_HEADER = "x-aec-path";
