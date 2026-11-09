import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./lib/supabase/database.types";
import { getSupabaseEnv } from "./lib/supabase/env";
import { homeAuthFallback } from "./lib/auth-url";
import { TENANT_COMPANY_HEADER, TENANT_HOST_HEADER, decideTenant, hostOnlyCookieOptions } from "./lib/tenant-domains";

const plainText: Record<number, string> = {
  400: "Nieprawidłowy adres.", 404: "Nie znaleziono.", 503: "Usługa chwilowo niedostępna. Spróbuj ponownie za chwilę.",
};
function plain(status: 400 | 404 | 503) {
  const response = new NextResponse(plainText[status], {
    status, headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function proxy(request: NextRequest) {
  const { url, key } = getSupabaseEnv();
  // SC-020-B: firma po hoście. Wartości nagłówków od klienta zawsze usuwamy;
  // ustawia je tylko rozpoznanie aktywnej, zweryfikowanej domeny w bazie.
  const forwarded = new Headers(request.headers);
  forwarded.delete(TENANT_COMPANY_HEADER);
  forwarded.delete(TENANT_HOST_HEADER);
  const decision = await decideTenant({
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    pathname: request.nextUrl.pathname,
    env: process.env,
    resolve: async hostname => {
      const anonymous = createServerClient<Database>(url, key, { cookies: { getAll: () => [], setAll: () => {} } });
      const { data, error } = await anonymous.rpc("tenant_domain_resolve", { target_host: hostname });
      if (error) throw new Error("tenant_resolve_failed");
      return data;
    },
  });
  if (decision.kind === "bad_host") return plain(400);
  // SC-020-D: fail closed when a customer's host cannot be resolved right now.
  if (decision.kind === "unavailable") return plain(503);
  if (decision.kind === "tenant") {
    if (decision.route.kind === "not_found") return plain(404);
    if (decision.route.kind === "redirect") {
      const response = NextResponse.redirect(new URL(decision.route.location, request.url));
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    }
    forwarded.set(TENANT_COMPANY_HEADER, decision.companyId);
    forwarded.set(TENANT_HOST_HEADER, decision.hostname);
  }
  const next = () => {
    // request.cookies.set (Supabase refresh) updates the original cookie header; keep it in sync.
    const cookie = request.headers.get("cookie");
    if (cookie === null) forwarded.delete("cookie"); else forwarded.set("cookie", cookie);
    return NextResponse.next({ request: { headers: forwarded } });
  };

  // Supabase sends auth links to the Site URL when their redirect address is not allow-listed; finish
  // them instead of leaving the user on a home page that ignores the code.
  if (request.nextUrl.pathname === "/") {
    const destination = homeAuthFallback(request.nextUrl.searchParams);
    if (!destination) return next();
    const response = NextResponse.redirect(new URL(destination, request.url));
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  let response = next();
  const client = createServerClient<Database>(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = next();
        // Session cookies stay host-only: a session from one company's domain is never sent to another's.
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, hostOnlyCookieOptions(options)));
      },
    },
  });
  await client.auth.getUser();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
// Every route that reads the tenant headers must be listed here (TENANT_TRUSTED_PATH_PREFIXES,
// checked by tests/tenant-domains.test.mjs): outside the matcher nothing strips a forged header.
export const config = {
  matcher: [
    "/login", "/register", "/forgot-password", "/reset-password", "/onboarding", "/dashboard/:path*", "/operator/:path*",
    // The purchase route reads the session to decide where to send the visitor:
    // without a refresh a returning user with an expired token reads as anonymous.
    "/kup/:path*",
    // SC-020-B: the auth callback runs on a customer's domain too; its host must be checked.
    "/auth/:path*",
    // Home page only when it carries a Supabase auth fallback, so ordinary visits never reach the proxy.
    { source: "/", has: [{ type: "query", key: "code" }] },
    { source: "/", has: [{ type: "query", key: "error" }] },
    { source: "/", has: [{ type: "query", key: "error_code" }] },
  ],
};
