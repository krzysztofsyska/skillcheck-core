import { NextResponse } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { url, key } = getSupabaseEnv();
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { ok: false, service: "supabase", status: response.status },
        { status: 503 }
      );
    }

    return NextResponse.json({ ok: true, service: "supabase" });
  } catch {
    return NextResponse.json(
      { ok: false, service: "supabase", error: "configuration" },
      { status: 503 }
    );
  }
}
