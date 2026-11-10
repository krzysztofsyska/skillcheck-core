import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../lib/company-access";
import { whiteLabelEnabled } from "../../../../lib/white-label-flag";
import { whiteLabelAudit, type BrandEvent, type DomainEvent } from "../../../../lib/white-label-audit";

export const metadata: Metadata = { title: "Historia zmian marki i domen" };
const dates = new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Warsaw" });

/** SC-020-D: jedna historia zmian marki i domen firmy. Tylko właściciel (baza sprawdza ponownie). */
export default async function WhiteLabelHistory({ params }: { params: Promise<{ companyId: string }> }) {
  if (!whiteLabelEnabled()) notFound();
  const { companyId } = await params;
  const { client, company, user } = await companyAccess(companyId);
  const back = <nav><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link></nav>;
  if (user.id !== company.owner_id) {
    return <main className="workspace"><section>{back}<h1>Historia zmian marki i domen</h1>
      <p className="notice">Historię zmian widzi właściciel konta firmy.</p></section></main>;
  }
  const [brand, domains] = await Promise.all([
    client.rpc("brand_editor_state", { target_company: companyId }),
    client.rpc("tenant_domain_state", { target_company: companyId }),
  ]);
  const brandEvents = brand.error ? [] : ((brand.data as { events?: BrandEvent[] } | null)?.events ?? []);
  const domainState = domains.error ? null : (domains.data as { domains?: { id: string; hostname: string }[]; events?: DomainEvent[] } | null);
  const entries = whiteLabelAudit({
    brandEvents, domainEvents: domainState?.events ?? [], viewerId: user.id,
    hostnames: new Map((domainState?.domains ?? []).map(d => [d.id, d.hostname])),
  });
  return <main className="workspace"><section>{back}
    <p className="eyebrow">WHITE-LABEL</p><h1>Historia zmian marki i domen — {company.name}</h1>
    <p className="lead">Kto i kiedy zmienił wygląd panelu lub domeny firmy. Wcześniejszą wersję marki przywrócisz na stronie{" "}
      <Link href={`/dashboard/${companyId}/marka`}>Wygląd panelu</Link>, a domenę wyłączysz lub odwołasz na stronie{" "}
      <Link href={`/dashboard/${companyId}/domeny`}>Domeny</Link>.</p>
    <p>Pokazujemy ostatnie zmiany: do 100 zmian wyglądu panelu i do 50 zmian domen.</p>
    {(brand.error || domains.error) && <p className="notice" role="status">Część historii jest chwilowo niedostępna.</p>}
    {entries.length ? <ul>{entries.map((e, i) => <li key={i}>{dates.format(new Date(e.at))} — {e.area === "marka" ? "Marka" : "Domena"} ({e.subject}): {e.action} — {e.who}</li>)}</ul>
      : <p>Brak zmian.</p>}
  </section></main>;
}
