/**
 * SC-020-D — wspólna historia zmian white-label dla właściciela firmy: marka
 * (branding.events przez public.brand_editor_state) i domeny
 * (tenant_domains.events przez public.tenant_domain_state). Obie funkcje bazy
 * są tylko dla właściciela; tu wyłącznie łączymy i porządkujemy wyniki.
 * Bez nowych tabel i bez migracji: dzienniki źródłowe są jedynym zapisem.
 */
export type BrandEvent = { action: string; actor: string | null; at: string; version_id?: string | null; asset_id?: string | null };
export type DomainEvent = { domain_id: string; action: string; by_owner: boolean; at: string };
export type AuditEntry = { at: string; area: 'marka' | 'domena'; subject: string; action: string; who: string };

const brandActions: Record<string, string> = {
  asset_registered: 'dodano plik marki', draft_saved: 'zapisano szkic', published: 'opublikowano wersję', rolled_back: 'przywrócono wcześniejszą wersję',
};
const domainActions: Record<string, string> = {
  claimed: 'dodano', verified: 'potwierdzono DNS', verification_failed: 'nie znaleziono rekordu DNS', reverified: 'ponownie potwierdzono DNS',
  verification_lapsed: 'weryfikacja wygasła — wymagana ponowna', verification_conflict: 'domena potwierdzona przez inne konto',
  tls_ready: 'certyfikat gotowy', tls_failed: 'certyfikat niegotowy', activated: 'włączono', deactivated: 'wyłączono',
  revoked: 'odwołano', expired: 'zgłoszenie wygasło',
};

const time = (value: string) => { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; };

/** Wpisy z obu dzienników, od najnowszego. Nieznane akcje pokazujemy dosłownie (nic nie ginie). */
export function whiteLabelAudit(input: {
  brandEvents: readonly BrandEvent[]; domainEvents: readonly DomainEvent[];
  hostnames: ReadonlyMap<string, string>; viewerId: string; limit?: number;
}): AuditEntry[] {
  const entries: AuditEntry[] = [
    ...input.brandEvents.map(e => ({
      at: e.at, area: 'marka' as const, subject: 'wygląd panelu', action: brandActions[e.action] ?? e.action,
      who: e.actor === null ? 'system' : e.actor === input.viewerId ? 'Ty' : 'inny użytkownik',
    })),
    ...input.domainEvents.map(e => ({
      at: e.at, area: 'domena' as const, subject: input.hostnames.get(e.domain_id) ?? 'domena', action: domainActions[e.action] ?? e.action,
      who: e.by_owner ? 'właściciel' : 'automatycznie',
    })),
  ];
  return entries.sort((a, b) => time(b.at) - time(a.at)).slice(0, Math.max(0, input.limit ?? 100));
}
