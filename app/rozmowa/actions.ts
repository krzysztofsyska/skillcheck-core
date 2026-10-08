"use server";

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { createClient } from "../../lib/supabase/server";
import { normalizeSalesLead, signSalesLead, type SalesLeadFields } from "../../lib/sales-lead-signature";

export type LeadState = {
  status: "idle" | "error" | "success";
  message: string;
  retry: { key: string; fingerprint: string } | null;
};
export type LeadInput = SalesLeadFields & { idempotency_key: string };
const generic = "Nie udało się zapisać zgłoszenia. Dane zostały w formularzu. Możesz spróbować ponownie.";
const unavailable = "Formularz nie przyjmuje teraz zgłoszeń.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limits = { first_name: 80, company_name: 160, email: 254, phone: 32, needs: 1000 } as const;

function result(code: string, message: string, retry: LeadState["retry"] = null, success = false): LeadState {
  // Only locally selected enum codes: never provider errors or contact data.
  console.info(code);
  return { status: success ? "success" : "error", message, retry };
}

export async function submitLead(previous: LeadState, input: LeadInput): Promise<LeadState> {
  let retry: LeadState["retry"] = null;
  try {
    const secret = process.env.SALES_LEAD_REQUEST_SECRET ?? "";
    if (process.env.SALES_LEADS_ENABLED !== "true" || !process.env.SALES_LEAD_NOTICE?.trim() || Buffer.byteLength(secret) < 32) {
      return result("sales_lead_unavailable", unavailable);
    }
    if (!input || typeof input !== "object" || typeof input.idempotency_key !== "string" || !uuid.test(input.idempotency_key)) {
      return result("sales_lead_rejected", generic);
    }
    for (const name of Object.keys(limits) as (keyof SalesLeadFields)[]) {
      const value = input[name];
      if (name === "phone" && value === null) continue;
      if (typeof value !== "string" || value.length > limits[name] * 2 || Array.from(value).length > limits[name]) {
        return result("sales_lead_rejected", generic);
      }
      // CR is permitted only as a line ending in needs, before canonical normalization.
      const controls = name === "needs" ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/;
      if (controls.test(value)) return result("sales_lead_rejected", generic);
    }
    const fields = normalizeSalesLead(input);
    if (!fields.first_name || !fields.company_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)
      || Array.from(fields.email).length > 254 || fields.email.length < 3
      || Array.from(fields.needs).length < 10
      || (fields.phone !== null && !/^[0-9+().\-\s]{5,32}$/.test(fields.phone))) {
      return result("sales_lead_rejected", generic);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    // Previous state is untrusted. It only selects a UUID; the database still checks content/idempotency.
    const key = previous?.retry?.fingerprint === fingerprint && typeof previous.retry.key === "string" && uuid.test(previous.retry.key)
      ? previous.retry.key : input.idempotency_key;
    retry = { key, fingerprint };
    const source_ip = (await headers()).get("x-real-ip")?.trim() ?? "";
    const family = isIP(source_ip);
    if (!(family === 4 || (family === 6 && /^[0-9a-f:]{2,39}$/i.test(source_ip)))) {
      return result("sales_lead_unavailable", unavailable, retry);
    }
    const client = await createClient();
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError && authError.name !== "AuthSessionMissingError") return result("sales_lead_unavailable", unavailable, retry);
    const issued_at_us = Date.now() * 1000;
    const request_signature = signSalesLead({ ...fields, idempotency_key: key, source_ip, issued_at_us, submitted_by: auth.user?.id ?? null }, secret);
    const { data, error } = await client.rpc("submit_sales_lead", {
      ...fields, idempotency_key: key, source_ip, issued_at_us, request_signature,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return result("sales_lead_rejected", generic, retry);
    const row = data[0];
    if ((row.result_code === "accepted" || row.result_code === "replay") && typeof row.lead_id === "string" && uuid.test(row.lead_id)) {
      return result(row.result_code === "accepted" ? "sales_lead_accepted" : "sales_lead_replay",
        "Zgłoszenie zostało zapisane. To nie jest rezerwacja terminu rozmowy.", null, true);
    }
    switch (row.result_code) {
      case "sales_lead_rate_limited": return result(row.result_code, "Nie udało się teraz przyjąć zgłoszenia. Spróbuj później.", retry);
      case "sales_lead_unavailable": return result(row.result_code, unavailable, retry);
      case "sales_lead_idempotency_conflict": return result(row.result_code, "To zgłoszenie różni się od poprzedniej próby. Wyślij je ponownie.");
      case "sales_lead_unauthorized": return result(row.result_code, generic, retry);
      default: return result("sales_lead_rejected", generic, retry);
    }
  } catch {
    return result("sales_lead_rejected", generic, retry);
  }
}
