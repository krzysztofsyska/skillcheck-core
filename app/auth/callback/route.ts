import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../lib/supabase/server";
import { callbackDestination } from "../../../lib/auth-url";
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  let destination = '/login?message=callback';
  if (code) {
    const client = await createClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (!error) {
      destination = callbackDestination(request.nextUrl.searchParams.get("flow"));
    }
  }
  const response = NextResponse.redirect(new URL(destination, request.url));
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
