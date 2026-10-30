import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./lib/supabase/database.types";
import { getSupabaseEnv } from "./lib/supabase/env";
import { homeAuthFallback } from "./lib/auth-url";

export async function proxy(request: NextRequest) {
  // Supabase sends auth links to the Site URL when their redirect address is not allow-listed; finish
  // them instead of leaving the user on a home page that ignores the code.
  if (request.nextUrl.pathname === "/") {
    const destination = homeAuthFallback(request.nextUrl.searchParams);
    if (!destination) return NextResponse.next();
    const response = NextResponse.redirect(new URL(destination, request.url));
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  let response = NextResponse.next({ request });
  const { url, key } = getSupabaseEnv();
  const client = createServerClient<Database>(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  await client.auth.getUser();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  matcher: [
    "/login", "/register", "/forgot-password", "/reset-password", "/onboarding", "/dashboard/:path*", "/operator/:path*",
    // Home page only when it carries a Supabase auth fallback, so ordinary visits never reach the proxy.
    { source: "/", has: [{ type: "query", key: "code" }] },
    { source: "/", has: [{ type: "query", key: "error" }] },
    { source: "/", has: [{ type: "query", key: "error_code" }] },
  ],
};
