import 'server-only';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { salesOperator } from '../sales/access';
import {
  AI_COST_NOTICES, COST_GROUPINGS, MARGIN_GROUPINGS, MARGIN_STATUS, OTHER_COST_CATEGORIES, PACKAGE_CODES,
  describeCostMicros, describeReasons, formatMicros, formatPln, formatRate, parseGrouping, parsePeriod, type CostGrouping, type CostMicros, type MarginGrouping,
} from '../../../lib/ai-cost-dashboard';
import { addFxRate, addOtherCost } from './actions';
import styles from '../sales/sales.module.css';
import own from './ai-costs.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Koszty AI i marża | SkillCheck', robots: { index: false, follow: false } };

const OTHER_COSTS_PAGE = 100;
const describeHeld = (held: Record<string, number>) => {
  const parts = Object.entries(held ?? {}).map(([currency, micros]) => formatMicros(micros, currency));
  return parts.length ? ` (${parts.join(', ')} niewykorzystane)` : '';
};
const dates = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeZone: 'Europe/Warsaw' });

/** SC-021-D: internal AI cost and contribution-margin panel. Operator only (the same gate as
 * /operator/billing); every RPC re-checks the operator in the database. Read-only apart from the
 * two append-only forms (exchange rates, other variable costs). Never shown to companies. */
export default async function OperatorAiCostsPage({ searchParams }: {
  searchParams: Promise<{ from?: string; to?: string; view?: string; margin?: string; status?: string; cq?: string; oc?: string; op?: string }>;
}) {
  const client = await salesOperator();
  const params = await searchParams;
  const period = parsePeriod(params.from, params.to);
  const view = parseGrouping<CostGrouping>(params.view, COST_GROUPINGS, 'company');
  const marginView = parseGrouping<MarginGrouping>(params.margin, MARGIN_GROUPINGS, 'company');
  const range = { from_month: period.from, to_month: period.to };
  // Company picker for the cost form: the operator list is capped at 200, so it is searchable.
  const companySearch = (params.cq ?? '').trim().slice(0, 200);
  // Other cost lines: optional company filter and pages of 100 in a stable order.
  const costCompany = typeof params.oc === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.oc) ? params.oc : null;
  const costPage = Math.min(Math.max(Number.parseInt(params.op ?? '0', 10) || 0, 0), 9999);
  const [costTotal, costRows, marginTotal, marginRows, rates, otherCosts, companies] = await Promise.all([
    client.rpc('sc021_operator_ai_costs', { ...range, group_by: 'total' }),
    client.rpc('sc021_operator_ai_costs', { ...range, group_by: view }),
    client.rpc('sc021_operator_margin', { ...range, group_by: 'total' }),
    client.rpc('sc021_operator_margin', { ...range, group_by: marginView }),
    client.rpc('sc021_operator_fx_rates'),
    client.rpc('sc021_operator_other_costs', { ...range, target_company: costCompany, page_offset: costPage * OTHER_COSTS_PAGE, page_size: OTHER_COSTS_PAGE + 1 }),
    client.rpc('sc19_operator_companies', { search: companySearch || null }),
  ]);
  if ([costTotal, costRows, marginTotal, marginRows, rates, otherCosts].some(r => r.error?.code === '42501')) notFound();
  if (costTotal.error || costRows.error || marginTotal.error || marginRows.error || !costTotal.data || !costRows.data
    || !marginTotal.data || !marginRows.data) throw new Error('Nie udało się odczytać kosztów AI.');
  const total = costTotal.data[0] ?? null;
  const margin = marginTotal.data[0] ?? null;
  const notice = params.status && Object.hasOwn(AI_COST_NOTICES, params.status) ? AI_COST_NOTICES[params.status as keyof typeof AI_COST_NOTICES] : null;
  const query = new URLSearchParams({ from: period.from.slice(0, 7), to: period.to.slice(0, 7), view, margin: marginView }).toString();
  const month = period.from.slice(0, 7);
  const costLines = (otherCosts.data ?? []).slice(0, OTHER_COSTS_PAGE);
  const hasNextCosts = (otherCosts.data ?? []).length > OTHER_COSTS_PAGE;
  const costLink = (pageNo: number) => `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(query)),
    ...(companySearch ? { cq: companySearch } : {}), ...(costCompany ? { oc: costCompany } : {}), op: String(pageNo) })}#other`;

  return <main className={styles.page}>
    <nav><Link href="/operator/billing">Pakiety firm</Link><Link href="/operator/sales">Proces sprzedaży</Link><Link href="/">Strona główna</Link></nav>
    <header><p className={styles.eyebrow}>SKILLCHECK · KOSZTY AI</p><h1>Koszty AI i marża</h1>
      <p>Ile kosztowały wywołania AI i ile zostaje z przychodu. Widok wewnętrzny — firmy go nie widzą.
        Kwoty oznaczone „szacunek (stawki testowe)” nie są prawdziwymi kosztami dostawcy.</p></header>
    {notice && <p role="status" className={styles.empty}>{notice}</p>}
    {period.adjusted && <p role="status" className={styles.empty}>Okres był nieprawidłowy (najwyżej 24 miesiące, „do” nie wcześniej niż „od”) — pokazuję bieżący miesiąc.</p>}

    <form className={styles.filters} method="get">
      <label>Od miesiąca <input type="month" name="from" defaultValue={period.from.slice(0, 7)} /></label>
      <label>Do miesiąca <input type="month" name="to" defaultValue={period.to.slice(0, 7)} /></label>
      <label>Koszty według <select name="view" defaultValue={view}>
        {Object.entries(COST_GROUPINGS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <label>Marża według <select name="margin" defaultValue={marginView}>
        {Object.entries(MARGIN_GROUPINGS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
      <button type="submit">Pokaż</button>
    </form>

    <section className={styles.card} aria-labelledby="summary">
      <h2 id="summary">Podsumowanie okresu</h2>
      {!total ? <p>W tym okresie nie było wywołań AI.</p> : <>
        <p><strong>{total.attempts}</strong> wywołań AI w <strong>{total.operations}</strong> operacjach
          (ponowienia jednej analizy liczą się jako jedna operacja).</p>
        <ul>
          <li>Koszt na stawkach zatwierdzonych: <strong>{formatPln(total.confirmed_pln_minor)}</strong> ({total.confirmed_count} wywołań)</li>
          <li>Szacunek (stawki testowe): <strong>{formatPln(total.placeholder_pln_minor)}</strong> ({total.placeholder_count} wywołań)</li>
          <li>Bez stawki — koszt nieznany: {total.unpriced_count} · Wynik nieznany, mogło być naliczone: {total.unknown_count}
            · Nienaliczone: {total.released_count}</li>
          {(total.live_reservations > 0 || total.reserved_count > 0) && <li>Rezerwacje budżetu w toku (niewliczone do kosztu):
            {' '}{total.live_reservations}{describeHeld(total.reservations_unused_micros as Record<string, number>)}</li>}
          {total.bounds_exceeded_count > 0 && <li>Ponad limit tokenów trasy (do sprawdzenia): {total.bounds_exceeded_count}</li>}
        </ul>
        {total.fx_missing && <p className={styles.hint}>Brak kursu dla części walut — kwoty w złotych są niedostępne. Dodaj kurs poniżej.</p>}
        {total.fx_placeholder && <p className={styles.hint}>Przeliczenie na złote używa kursu testowego — to szacunek.</p>}
        {total.fx_stale && <p className={styles.hint}>Część kosztu przeliczono kursem starszym niż 45 dni — dodaj aktualny kurs.</p>}
        <p className={styles.hint}>W walucie dostawcy: {describeCostMicros(total.cost_micros as CostMicros).join(' · ') || 'brak kosztów'}</p>
      </>}
      {margin && <p>Marża w okresie: <strong>{formatPln(margin.margin_minor)}</strong> — {MARGIN_STATUS[margin.margin_status]}
        {margin.reasons.length > 0 && <span className={styles.hint}> ({describeReasons(margin.reasons)})</span>}</p>}
    </section>

    <section aria-labelledby="margin">
      <h2 id="margin">Marża według: {MARGIN_GROUPINGS[marginView].toLowerCase()}</h2>
      <p className={styles.hint}>Marża = przychód netto (opłacone zamówienia, brutto minus VAT z cennika) − koszt AI w złotych − inne koszty zmienne.
        Ręczne przydziały pakietu nie mają kwoty w systemie, więc ich przychód nie jest wliczony.
        Koszt AI liczy się do pakietu, który firma miała w chwili wywołania; inny koszt bez wskazanego pakietu — do pakietu firmy na koniec miesiąca.</p>
      {!marginRows.data.length ? <p className={styles.empty}>Brak przychodu i kosztów w tym okresie.</p> :
        <div className={own.scroll}><table className={own.table}>
          <thead><tr><th scope="col">{MARGIN_GROUPINGS[marginView]}</th><th scope="col">Opłacone zamówienia</th><th scope="col">Przychód netto</th>
            <th scope="col">Koszt AI</th><th scope="col">Inne koszty</th><th scope="col">Marża</th><th scope="col">Uwagi</th></tr></thead>
          <tbody>{marginRows.data.map(row => <tr key={row.group_key}>
            <th scope="row">{row.group_label}</th>
            <td>{row.paid_orders}{row.payments_without_amount > 0 ? ` (+${row.payments_without_amount} bez kwoty)` : ''}</td>
            <td>{formatPln(row.revenue_net_minor)}</td><td>{formatPln(row.ai_cost_pln_minor)}</td><td>{formatPln(row.other_costs_minor)}</td>
            <td><strong>{formatPln(row.margin_minor)}</strong><br /><span className={own.status} data-status={row.margin_status}>{MARGIN_STATUS[row.margin_status]}</span></td>
            <td className={styles.hint}>{describeReasons(row.reasons) || '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section aria-labelledby="costs">
      <h2 id="costs">Koszty AI według: {COST_GROUPINGS[view].toLowerCase()}</h2>
      {view === 'candidate' && <p className={styles.hint}>Kandydaci są pokazani wyłącznie jako pseudonim — bez imion, e-maili i treści CV.</p>}
      {!costRows.data.length ? <p className={styles.empty}>W tym okresie nie było wywołań AI.</p> :
        <div className={own.scroll}><table className={own.table}>
          <thead><tr><th scope="col">{COST_GROUPINGS[view]}</th><th scope="col">Operacje / wywołania</th><th scope="col">Koszt (stawki zatwierdzone)</th>
            <th scope="col">Szacunek (stawki testowe)</th><th scope="col">Bez kosztu</th></tr></thead>
          <tbody>{costRows.data.map(row => <tr key={row.group_key}>
            <th scope="row">{row.group_label}{row.company_name && view !== 'company' ? <span className={styles.hint}><br />{row.company_name}</span> : null}</th>
            <td>{row.operations} / {row.attempts}</td>
            <td>{formatPln(row.confirmed_pln_minor)} <span className={styles.hint}>({row.confirmed_count})</span></td>
            <td>{formatPln(row.placeholder_pln_minor)} <span className={styles.hint}>({row.placeholder_count})</span></td>
            <td className={styles.hint}>bez stawki {row.unpriced_count} · nieznany {row.unknown_count} · nienaliczone {row.released_count}
              {row.live_reservations > 0 ? ` · rezerwacje w toku ${row.live_reservations}${describeHeld(row.reservations_unused_micros as Record<string, number>)}` : ''}
              {row.bounds_exceeded_count > 0 ? ` · ponad limit ${row.bounds_exceeded_count}` : ''}
              {row.fx_missing ? ' · brak kursu' : ''}{row.fx_placeholder ? ' · kurs testowy' : ''}{row.fx_stale ? ' · kurs starszy niż 45 dni' : ''}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section className={styles.card} aria-labelledby="rates">
      <h2 id="rates">Kursy walut (do przeliczenia kosztu AI na złote)</h2>
      <p className={styles.hint}>Kursu nie da się zmienić ani usunąć. Poprawka to nowy wpis z tą samą datą — liczy się najnowszy.
        Kurs prawdziwy ma pierwszeństwo przed testowym.</p>
      {rates.error ? <p className={styles.empty}>Nie udało się odczytać kursów. Odśwież stronę.</p> :
        <ul>{(rates.data ?? []).map(rate => <li key={rate.id}>1 {rate.base_currency} = {formatRate(rate.rate_micros)} PLN od {dates.format(new Date(rate.valid_from))}
          {rate.placeholder ? ' — kurs testowy (szacunek)' : ''} · {rate.source_note}{rate.from_migration ? ' · wpis startowy' : ''}</li>)}</ul>}
      <details><summary>Dodaj kurs</summary>
        <form action={addFxRate} className={styles.form}>
          <input type="hidden" name="requestKey" value={randomUUID()} /><input type="hidden" name="back" value={query} />
          <label>Waluta <select name="base" defaultValue="USD"><option value="USD">USD</option><option value="EUR">EUR</option></select></label>
          <label>Ile złotych za 1 jednostkę (do 6 miejsc po przecinku) <input name="rate" inputMode="decimal" required placeholder="np. 4,0512" /></label>
          <label>Obowiązuje od dnia (od północy UTC) <input type="date" name="validFrom" required /></label>
          <label>Źródło <input name="note" required minLength={3} maxLength={300} placeholder="np. NBP tabela A z dnia" /></label>
          <label className={styles.confirm}><input type="checkbox" name="placeholder" value="yes" /> To kurs testowy (marża będzie oznaczona jako szacunek).</label>
          <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Sprawdziłem kurs i źródło. Wpisu nie da się cofnąć, tylko poprawić nowym.</label>
          <button type="submit">Zapisz kurs</button>
        </form>
      </details>
    </section>

    <section className={styles.card} aria-labelledby="other">
      <h2 id="other">Inne koszty zmienne (netto, w złotych)</h2>
      <p className={styles.hint}>Np. opłaty za płatności, SMS-y. Wpisuje tylko operator. Poprawka zastępuje poprzednią wersję, historia zostaje.</p>
      {otherCosts.error ? <p className={styles.empty}>Nie udało się odczytać kosztów. Odśwież stronę.</p>
        : !costLines.length ? <p className={styles.empty}>{costPage > 0 ? 'Brak wpisów na tej stronie.' : 'Brak wpisów w tym okresie.'}</p>
        : <ul>{costLines.map(line => <li key={line.id}>{line.period_month.slice(0, 7)} · {line.company_name ?? 'Firma usunięta'}
          {line.package_code ? ` · ${line.package_code}` : ''} · {OTHER_COST_CATEGORIES[line.category]}: <strong>{formatPln(line.amount_minor)}</strong>
          {line.note ? ` · ${line.note}` : ''}{line.superseded ? ' · zastąpione nowszą wersją' : ''}
          {!line.superseded && <details><summary>Popraw</summary>
            <form action={addOtherCost} className={styles.form}>
              <input type="hidden" name="requestKey" value={randomUUID()} /><input type="hidden" name="back" value={query} />
              <input type="hidden" name="supersedes" value={line.id} /><input type="hidden" name="month" value={line.period_month.slice(0, 7)} />
              <input type="hidden" name="companyId" value={line.company_id} /><input type="hidden" name="package" value={line.package_code ?? ''} />
              <input type="hidden" name="category" value={line.category} />
              <label>Nowa kwota netto (zł) <input name="amount" inputMode="decimal" required /></label>
              <label>Notatka <input name="note" maxLength={300} /></label>
              <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Poprawka zastępuje tę wersję.</label>
              <button type="submit">Zapisz poprawkę</button>
            </form></details>}
        </li>)}</ul>}
      <nav aria-label="Strony innych kosztów">
        {costPage > 0 && <Link href={costLink(costPage - 1)}>poprzednia strona</Link>}
        {hasNextCosts && <Link href={costLink(costPage + 1)}>następna strona</Link>}
      </nav>
      {companies.data && <form className={styles.filters} method="get" action="#other">
        {Object.entries({ from: period.from.slice(0, 7), to: period.to.slice(0, 7), view, margin: marginView, cq: companySearch }).map(([k, v]) =>
          <input key={k} type="hidden" name={k} value={v} />)}
        <label>Pokaż koszty firmy <select name="oc" defaultValue={costCompany ?? ''}><option value="">wszystkie firmy</option>
          {companies.data.map(c => <option key={c.company_id} value={c.company_id}>{c.company_name}</option>)}</select></label>
        <button type="submit">Pokaż</button>
      </form>}
      <details open={Boolean(companySearch)}><summary>Dodaj koszt</summary>
        <form className={styles.filters} method="get">
          {Object.entries({ from: period.from.slice(0, 7), to: period.to.slice(0, 7), view, margin: marginView }).map(([k, v]) =>
            <input key={k} type="hidden" name={k} value={v} />)}
          <label>Szukaj firmy (nazwa lub ID) <input name="cq" defaultValue={companySearch} maxLength={200} /></label>
          <button type="submit">Szukaj</button>
        </form>
        {companies.data && companies.data.length >= 200 && <p className={styles.hint}>Pokazano pierwsze 200 firm — zawęź wyszukiwanie, jeśli brakuje firmy.</p>}
        {companies.error || !companies.data ? <p className={styles.empty}>Nie udało się odczytać listy firm.</p> :
          <form action={addOtherCost} className={styles.form}>
            <input type="hidden" name="requestKey" value={randomUUID()} /><input type="hidden" name="back" value={query} />
            <label>Miesiąc <input type="month" name="month" defaultValue={month} required /></label>
            <label>Firma <select name="companyId" required>{companies.data.map(c => <option key={c.company_id} value={c.company_id}>{c.company_name}</option>)}</select></label>
            <label>Pakiet (opcjonalnie) <select name="package" defaultValue=""><option value="">bez pakietu</option>
              {PACKAGE_CODES.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
            <label>Rodzaj <select name="category">{Object.entries(OTHER_COST_CATEGORIES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
            <label>Kwota netto (zł) <input name="amount" inputMode="decimal" required placeholder="np. 3,50" /></label>
            <label>Notatka <input name="note" maxLength={300} /></label>
            <label className={styles.confirm}><input type="checkbox" name="confirm" value="yes" required /> Kwota pochodzi z faktury lub wyciągu. Wpisu nie da się usunąć, tylko poprawić.</label>
            <button type="submit">Zapisz koszt</button>
          </form>}
      </details>
    </section>
  </main>;
}
