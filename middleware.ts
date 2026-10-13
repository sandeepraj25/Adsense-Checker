import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { PATH_HEADER, requestOrigin } from "@/lib/request-origin";

/**
 * A cheap gate, not the security boundary.
 *
 * Middleware runs on the edge runtime, where the database is not
 * reachable, so all it can do is check whether a session cookie is
 * present and bounce obvious anonymous traffic before it costs a render.
 * Every protected page and route handler independently resolves the
 * session against the database — that check is the real one, and it is
 * what rejects a forged or expired cookie.
 */
export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);

  // API routes use cookie authentication, so reject browser requests that
  // originate on another site before they reach a mutating handler. Gateway
  // webhooks are deliberately exempt: each is authenticated by its provider
  // signature instead of a browser cookie.
  if (unsafeMethod && path.startsWith("/api/") && !path.startsWith("/api/webhooks/")) {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      fetchSite === "cross-site" ||
      (origin !== null && origin !== requestOrigin(request.headers, request.nextUrl))
    ) {
      return withSecurityHeaders(
        NextResponse.json(
          { ok: false, code: "CSRF_REJECTED", message: "This request was rejected." },
          { status: 403 },
        ),
      );
    }
  }

  // Pages that need an account. /checkout is here so a logged-out visitor
  // is sent to log in with `next=/checkout?plan=…` and lands back on the
  // exact plan; the page itself re-checks the session on the server.
  const protectedPage =
    path.startsWith("/dashboard") ||
    path.startsWith("/admin") ||
    path === "/checkout" ||
    path.startsWith("/checkout/");

  if (!protectedPage) {
    if (!request.headers.has(PATH_HEADER)) {
      return withSecurityHeaders(NextResponse.next());
    }
    const stripped = new Headers(request.headers);
    stripped.delete(PATH_HEADER);
    return withSecurityHeaders(NextResponse.next({ request: { headers: stripped } }));
  }

  const hasCookie = request.cookies.has(SESSION_COOKIE);
  if (hasCookie) {
    // Tell the server-side guard which page was requested, so that when
    // the cookie turns out to be expired or revoked the login page can
    // send the person back to /dashboard/billing (say) rather than to the
    // dashboard home. Overwritten on every request, so a client cannot
    // inject it, and the login page still runs it through safeNextPath.
    const forwarded = new Headers(request.headers);
    forwarded.set(PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
    return withSecurityHeaders(NextResponse.next({ request: { headers: forwarded } }));
  }

  const login = new URL("/login", request.url);
  login.searchParams.set(
    "next",
    request.nextUrl.pathname + request.nextUrl.search,
  );
  return withSecurityHeaders(NextResponse.redirect(login));
}

function withSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
