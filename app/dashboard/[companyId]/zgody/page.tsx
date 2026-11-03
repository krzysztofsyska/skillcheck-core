import Link from 'next/link';
import type { Metadata } from 'next';
import { companyAccess } from '../../../../lib/company-access';
import {
  MARKETING_CONSENT_TEXT, isMarketingConsentActive, marketingConsentNotices,
  type MarketingConsentState,
} from '../../../../lib/marketing-consent';
import { grantMarketingConsent, withdrawMarketingConsent } from './actions';

export const metadata: Metadata = { title: 'Zgody | SkillCheck' };

const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });

/** SC-CONSENT-001: the company's view of its consent to commercial contact.
 * One click to withdraw, one click to give it again; every change appends to the
 * database ledger with its exact wording, version and time. */
export default async function CompanyConsents({ params, searchParams }: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { companyId } = await params;
  const { client, company, user } = await companyAccess(companyId);
  const { status } = await searchParams;
  const { data, error } = await client.rpc('marketing_consent_state', { target_company: companyId });
  if (error) throw new Error('Nie udało się odczytać zgód firmy.');
  const state = ((Array.isArray(data) ? data[0] : data) ?? null) as MarketingConsentState | null;
  const active = isMarketingConsentActive(state);
  const isOwner = user.id === company.owner_id;

  return <main className="workspace"><section>
    <Link href={`/dashboard/${companyId}`}>← Panel firmy</Link>
    <p className="eyebrow">SKILLCHECK / ZGODY</p>
    <h1>Zgody — {company.name}</h1>
    {status && Object.hasOwn(marketingConsentNotices, status)
      && <p role="status" className="notice">{marketingConsentNotices[status as keyof typeof marketingConsentNotices]}</p>}

    <section aria-labelledby="marketing">
      <h2 id="marketing">Kontakt handlowy</h2>
      <p><strong>{active ? 'Zgoda jest aktywna.' : 'Nie masz aktywnej zgody na kontakt handlowy.'}</strong>
        {state && ` Ostatnia zmiana: ${dates.format(new Date(state.occurred_at))}.`}</p>
      <p>{state?.consent_text ?? MARKETING_CONSENT_TEXT}</p>
      <p>Zgoda jest dobrowolna. Jej brak nie ogranicza korzystania z SkillCheck ani z wykupionych pakietów.
        Historię zgód przechowujemy, aby móc wykazać, co i kiedy zostało zaznaczone — wycofanie nie usuwa wcześniejszego zapisu.</p>
      {isOwner ? <form action={active ? withdrawMarketingConsent : grantMarketingConsent}>
        <input type="hidden" name="companyId" value={companyId} />
        <button type="submit" className="button">{active ? 'Wycofaj zgodę' : 'Wyrażam zgodę'}</button>
      </form> : <p className="notice">Zgodę może zmienić właściciel firmy.</p>}
    </section>

    <p><Link href="/polityka-prywatnosci" target="_blank">Jak przetwarzamy dane — Polityka prywatności</Link></p>
  </section></main>;
}
