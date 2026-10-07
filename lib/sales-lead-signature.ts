import { createHmac } from 'node:crypto';

export type SalesLeadFields = {
  first_name: string; company_name: string; email: string;
  phone: string | null; needs: string;
};
export type SalesLeadSignatureInput = SalesLeadFields & {
  idempotency_key: string; source_ip: string; issued_at_us: number;
  submitted_by?: string | null;
};

export function normalizeSalesLead(fields: SalesLeadFields): SalesLeadFields {
  return {
    first_name: fields.first_name.replace(/\s+/g, ' ').trim(),
    company_name: fields.company_name.replace(/\s+/g, ' ').trim(),
    email: fields.email.trim().toLowerCase(),
    phone: fields.phone?.trim() || null,
    needs: fields.needs.replace(/\r\n?/g, '\n').trim(),
  };
}

/** Pure builder: no environment, request headers or network access. */
export function salesLeadCanonical(input: SalesLeadSignatureInput): string {
  if (!Number.isSafeInteger(input.issued_at_us)) throw new Error('sales_lead_invalid');
  const f = normalizeSalesLead(input);
  const field = (value: string) => `${Buffer.byteLength(value, 'utf8')}:${value}`;
  return ['v1', String(input.issued_at_us), input.idempotency_key.toLowerCase(),
    input.submitted_by?.toLowerCase() || '-', input.source_ip,
    field(f.first_name), field(f.company_name), field(f.email), field(f.phone || ''), field(f.needs)].join('\n');
}

export function signSalesLead(input: SalesLeadSignatureInput, secret: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('sales_lead_secret_invalid');
  return createHmac('sha256', secret).update(salesLeadCanonical(input), 'utf8').digest('hex');
}
