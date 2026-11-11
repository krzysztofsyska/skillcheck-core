import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../lib/supabase/server";
import { callbackDestination } from "../../../lib/auth-url";
import { withNext } from "../../../lib/safe-next-path";
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  let destination = '/login?message=callback';
  if (code) {
    const client = await createClient();
    const { data, error } = await client.auth.exchangeCodeForSession(code);
    if (!error) {
      // A link that reached us through the home-page fallback has no `flow`; the PKCE verifier stored by
      // resetPasswordForEmail still marks it as recovery.
      const flow = request.nextUrl.searchParams.get("flow") ?? ((data as { redirectType?: string | null }).redirectType === "recovery" ? "recovery" : null);
      // SC-BUY-002: a visitor who clicked "Kup PRESELEKCJĘ" before signing up gets
      // the purchase target back after confirming the address. Re-validated here
      // (the link crossed the user's mailbox) and never applied to recovery.
      destination = callbackDestination(flow);
      if (flow !== "recovery") destination = withNext(destination, request.nextUrl.searchParams.get("next"));
    }
  }
  const response = NextResponse.redirect(new URL(destination, request.url));
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
