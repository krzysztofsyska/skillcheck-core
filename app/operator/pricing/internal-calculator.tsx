'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_UNITS, PACKAGE_CODES, PACKAGE_LABELS, calculate, effectivePrice, cvChoices, defaultConfig, describeCode, formatPln, parseConfig, parsePln,
  validateConfig, type InternalConfig, type Scenario,
} from '../../../lib/pricing/internal-calculator';
import type { PackageCode } from '../../../lib/pricing/quote-engine';
import styles from './pricing.module.css';

const STORAGE_KEY = 'skillcheck.internal-pricing.v1';
const percent = (bps: number) => (bps / 100).toLocaleString('pl-PL', { maximumFractionDigits: 2 }) + '%';

function load(): InternalConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return (raw && parseConfig(JSON.parse(raw))) || defaultConfig();
  } catch {
    return defaultConfig();
  }
}

/** Text input for PLN amounts; commits grosze on blur, reverts invalid text. */
function Money({ value, onChange, label }: { value: number; onChange: (minor: number) => void; label: string }) {
  const shown = (value / 100).toFixed(2).replace('.', ',');
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return <input aria-label={label} inputMode="decimal" value={text} onChange={e => setText(e.target.value)}
    onBlur={() => { const v = parsePln(text); if (v === null) setText(shown); else onChange(v); }} />;
}

function Count({ value, onChange, label, min = 0 }: { value: number; onChange: (n: number) => void; label: string; min?: number }) {
  return <input aria-label={label} type="number" min={min} max={MAX_UNITS} step={1} value={value}
    onChange={e => { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n >= min && n <= MAX_UNITS) onChange(n); }} />;
}

/** Net price the engine uses for a gross input; warns when whole net grosze change the gross. */
function NetHint({ gross, vat }: { gross: number; vat: number }) {
  if (gross === 0) return null;
  const effective = effectivePrice(gross, vat);
  return <span className={styles.unit}>netto {formatPln(effective.netMinor)}
    {effective.grossMinor !== gross && <strong className={styles.warn}> · po zaokrągleniu {formatPln(effective.grossMinor)} brutto</strong>}</span>;
}

function Percent({ value, onChange, label }: { value: number; onChange: (bps: number) => void; label: string }) {
  const shown = (value / 100).toString().replace('.', ',');
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return <input aria-label={label} inputMode="decimal" value={text} onChange={e => setText(e.target.value)}
    onBlur={() => {
      const t = text.trim().replace(',', '.');
      const n = /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN;
      if (Number.isSafeInteger(n) && n <= 10000) onChange(n); else setText(shown);
    }} />;
}

export function InternalCalculator() {
  const [config, setConfig] = useState<InternalConfig>(defaultConfig);
  const [loaded, setLoaded] = useState(false);
  const [scenario, setScenario] = useState<Scenario>({ packageCode: 'PRESELEKCJA', cvCount: 60, quantities: {}, ordersPerMonth: 10 });
  const [editPackage, setEditPackage] = useState<PackageCode>('PRESELEKCJA');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { setConfig(load()); setLoaded(true); }, []);
  useEffect(() => {
    if (!loaded) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* storage unavailable: keep in memory */ }
  }, [config, loaded]);

  const update = (change: (draft: InternalConfig) => void) => setConfig(current => {
    const draft = structuredClone(current);
    change(draft);
    return draft;
  });
  const settings = config.packages[scenario.packageCode];
  const choices = cvChoices(settings);
  const cvCount = choices.includes(scenario.cvCount) ? scenario.cvCount : settings.cvIncluded;
  const result = useMemo(() => calculate(config, { ...scenario, cvCount }), [config, scenario, cvCount]);
  const validation = useMemo(() => validateConfig(config), [config]);
  const available = config.addons.filter(a => a.packages[scenario.packageCode].enabled);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'skillcheck-cennik-wewnetrzny.json'; a.click();
    URL.revokeObjectURL(url);
  };
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parseConfig(JSON.parse(await file.text()));
      if (!parsed) { setMessage('Plik ma niepoprawny format. Nic nie zmieniono.'); return; }
      setConfig(parsed); setMessage('Wczytano konfigurację z pliku.');
    } catch {
      setMessage('Nie udało się odczytać pliku. Nic nie zmieniono.');
    }
  };

  return <div className={styles.layout}>
    <section className={styles.card} aria-labelledby="scenario">
      <h2 id="scenario">Wycena zamówienia</h2>
      <div className={styles.fields}>
        <label>Pakiet<select value={scenario.packageCode}
          onChange={e => setScenario(s => ({ ...s, packageCode: e.target.value as PackageCode, quantities: {} }))}>
          {PACKAGE_CODES.map(c => <option key={c} value={c}>{PACKAGE_LABELS[c]}</option>)}</select></label>
        <label>Liczba CV<select value={cvCount} onChange={e => setScenario(s => ({ ...s, cvCount: Number(e.target.value) }))}>
          {choices.map(n => <option key={n} value={n}>{n}{n === settings.cvIncluded ? ' (w pakiecie)' : ''}</option>)}</select></label>
        <label>Zamówień miesięcznie<Count label="Zamówień miesięcznie" value={scenario.ordersPerMonth}
          onChange={n => setScenario(s => ({ ...s, ordersPerMonth: n }))} /></label>
      </div>
      {available.length > 0 && <details className={styles.details}>
        <summary>Dodatki w zamówieniu ({available.length} dostępnych)</summary>
        <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Dodatek</th><th>W pakiecie</th><th>Łącznie w zamówieniu (max {MAX_UNITS})</th></tr></thead>
          <tbody>{available.map(a => {
            const included = a.packages[scenario.packageCode].included;
            return <tr key={a.code}><td>{a.name}<span className={styles.unit}> / {a.unit}</span></td><td>{included}</td>
              <td><Count label={`${a.name} — łącznie`} min={included}
                value={Math.max(included, scenario.quantities[a.code] ?? 0)}
                onChange={n => setScenario(s => ({ ...s, quantities: { ...s.quantities, [a.code]: n } }))} /></td></tr>;
          })}</tbody></table></div>
      </details>}
    </section>

    <section className={styles.card} aria-labelledby="result" aria-live="polite">
      <h2 id="result">Wynik</h2>
      {!result.ok ? <p className={styles.error} role="alert">{describeCode(result.code)}</p> : <>
        <div className={styles.tableWrap}><table className={styles.table}>
          <caption>Cena dla klienta (silnik wycen)</caption>
          <thead><tr><th>Pozycja</th><th>Ilość</th><th>W pakiecie</th><th>Płatne</th><th>Netto</th></tr></thead>
          <tbody>{result.quote.lines.map(l => <tr key={l.kind + l.code}>
            <td>{l.kind === 'base' ? `Pakiet ${PACKAGE_LABELS[scenario.packageCode]}` : l.kind === 'cv_overage' ? 'CV ponad pakiet'
              : config.addons.find(a => a.code === l.code)?.name ?? l.code}</td>
            <td>{l.quantity}</td><td>{l.included}</td><td>{l.billed}</td><td className={styles.num}>{formatPln(l.netMinor)}</td></tr>)}</tbody>
          <tfoot>
            <tr><th colSpan={4}>Netto</th><td className={styles.num}>{formatPln(result.quote.netMinor)}</td></tr>
            <tr><th colSpan={4}>VAT {percent(config.vatBasisPoints)}</th><td className={styles.num}>{formatPln(result.quote.vatMinor)}</td></tr>
            <tr><th colSpan={4}>Brutto — płaci klient</th><td className={styles.num}><strong>{formatPln(result.quote.grossMinor)}</strong></td></tr>
          </tfoot></table></div>
        <div className={styles.tableWrap}><table className={styles.table}>
          <caption>Twoje koszty (netto)</caption>
          <thead><tr><th>Koszt</th><th>Ilość</th><th>Kwota</th></tr></thead>
          <tbody>{result.costs.map(c => <tr key={c.code}><td>{c.label}</td><td>{c.quantity}</td><td className={styles.num}>{formatPln(c.costMinor)}</td></tr>)}</tbody>
          <tfoot><tr><th colSpan={2}>Razem koszty</th><td className={styles.num}>{formatPln(result.costMinor)}</td></tr></tfoot></table></div>
        <dl className={styles.summary}>
          <div><dt>Marża na zamówieniu</dt><dd data-negative={result.marginMinor < 0}>{formatPln(result.marginMinor)}</dd></div>
          <div><dt>Marża % (od netto)</dt><dd data-negative={result.marginMinor < 0}>{result.marginBasisPoints === null ? '—' : percent(result.marginBasisPoints)}</dd></div>
          <div><dt>Miesięcznie: przychód netto</dt><dd>{formatPln(result.monthly.netMinor)}</dd></div>
          <div><dt>Miesięcznie: marża</dt><dd data-negative={result.monthly.marginMinor < 0}>{formatPln(result.monthly.marginMinor)}</dd></div>
        </dl>
        {result.quote.blockedReasons.filter(r => r !== 'DRAFT_PREVIEW').length > 0 &&
          <p className={styles.hint}>Uwagi silnika: {result.quote.blockedReasons.filter(r => r !== 'DRAFT_PREVIEW').join(', ')}</p>}
      </>}
    </section>

    <section className={styles.card} aria-labelledby="packages">
      <h2 id="packages">Pakiety</h2>
      <p className={styles.hint}>Ceny brutto. Silnik liczy w pełnych groszach netto, a VAT dolicza do sumy zamówienia, więc pod każdą ceną widać jej kwotę netto. Pole z ceną 0,00 zł oznacza cenę jeszcze nieustaloną (oprócz FREE).</p>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Pakiet</th><th>Cena brutto</th><th>CV w pakiecie</th><th>Opcje liczby CV</th><th>Dopłata za CV ponad pakiet (brutto)</th></tr></thead>
        <tbody>{PACKAGE_CODES.map(code => {
          const p = config.packages[code];
          return <tr key={code}>
            <th scope="row">{PACKAGE_LABELS[code]}{code !== 'FREE' && p.grossMinor === 0 && <span className={styles.badge}>bez ceny</span>}</th>
            <td><Money label={`${PACKAGE_LABELS[code]} — cena brutto`} value={p.grossMinor} onChange={v => update(d => { d.packages[code].grossMinor = v; })} /><NetHint gross={p.grossMinor} vat={config.vatBasisPoints} /></td>
            <td><Count label={`${PACKAGE_LABELS[code]} — CV w pakiecie`} min={1} value={p.cvIncluded} onChange={n => update(d => { d.packages[code].cvIncluded = n; })} /></td>
            <td><input aria-label={`${PACKAGE_LABELS[code]} — opcje liczby CV`} defaultValue={p.cvOptions.join(', ')} key={p.cvOptions.join(',')}
              onBlur={e => {
                const list = e.target.value.split(/[,;\s]+/).filter(Boolean).map(Number);
                if (list.length && list.length <= 30 && list.every(n => Number.isSafeInteger(n) && n > 0 && n <= 10000))
                  update(d => { d.packages[code].cvOptions = Array.from(new Set(list)).sort((a, b) => a - b); });
                else e.target.value = p.cvOptions.join(', ');
              }} /></td>
            <td><Money label={`${PACKAGE_LABELS[code]} — dopłata za CV`} value={p.overageGrossPerCvMinor} onChange={v => update(d => { d.packages[code].overageGrossPerCvMinor = v; })} /><NetHint gross={p.overageGrossPerCvMinor} vat={config.vatBasisPoints} /></td>
          </tr>;
        })}</tbody></table></div>
    </section>

    <section className={styles.card} aria-labelledby="addons">
      <h2 id="addons">Dodatki i ich koszty</h2>
      <label className={styles.inline}>Ceny i limity dla pakietu<select value={editPackage} onChange={e => setEditPackage(e.target.value as PackageCode)}>
        {PACKAGE_CODES.map(c => <option key={c} value={c}>{PACKAGE_LABELS[c]}</option>)}</select></label>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Dodatek</th><th>Dostępny w {PACKAGE_LABELS[editPackage]}</th><th>W pakiecie</th><th>Cena za jednostkę (brutto)</th><th>Twój koszt za jednostkę (netto, wszystkie pakiety)</th></tr></thead>
        <tbody>{config.addons.map((a, i) => {
          const s = a.packages[editPackage];
          return <tr key={a.code}>
            <th scope="row">{a.name}<span className={styles.unit}> / {a.unit}</span></th>
            <td><input type="checkbox" aria-label={`${a.name} dostępny w ${PACKAGE_LABELS[editPackage]}`} checked={s.enabled}
              onChange={e => update(d => { d.addons[i].packages[editPackage].enabled = e.target.checked; })} /></td>
            <td><Count label={`${a.name} — w pakiecie`} value={s.included} onChange={n => update(d => { d.addons[i].packages[editPackage].included = n; })} /></td>
            <td><Money label={`${a.name} — cena brutto`} value={s.unitGrossMinor} onChange={v => update(d => { d.addons[i].packages[editPackage].unitGrossMinor = v; })} /><NetHint gross={s.unitGrossMinor} vat={config.vatBasisPoints} /></td>
            <td><Money label={`${a.name} — koszt własny`} value={a.unitCostMinor} onChange={v => update(d => { d.addons[i].unitCostMinor = v; })} /></td>
          </tr>;
        })}</tbody></table></div>
    </section>

    <section className={styles.card} aria-labelledby="general">
      <h2 id="general">Koszty ogólne</h2>
      <div className={styles.fields}>
        <label>VAT (%)<Percent label="VAT" value={config.vatBasisPoints} onChange={v => update(d => { d.vatBasisPoints = v; })} /></label>
        <label>Twój koszt analizy 1 CV (netto)<Money label="Koszt analizy 1 CV" value={config.cvCostMinor} onChange={v => update(d => { d.cvCostMinor = v; })} /></label>
        <label>Opłata za płatność (% brutto)<Percent label="Opłata za płatność" value={config.paymentFeeBasisPoints} onChange={v => update(d => { d.paymentFeeBasisPoints = v; })} /></label>
        <label>Koszt stały zamówienia (netto)<Money label="Koszt stały zamówienia" value={config.fixedCostPerOrderMinor} onChange={v => update(d => { d.fixedCostPerOrderMinor = v; })} /></label>
      </div>
    </section>

    <section className={styles.card} aria-labelledby="check">
      <h2 id="check">Kontrola przed publikacją</h2>
      {validation.ok ? <>
        <p role="status">Cennik przechodzi tę samą kontrolę, którą przejdzie przed publikacją dla klientów.</p>
        <ul>{PACKAGE_CODES.map(c => <li key={c}>{PACKAGE_LABELS[c]}: najwyższa możliwa kwota zamówienia {formatPln(validation.maxGross[c] ?? 0)} brutto</li>)}</ul>
      </> : <p className={styles.error} role="alert">{describeCode(validation.code)}</p>}
    </section>

    <section className={styles.card} aria-labelledby="data">
      <h2 id="data">Dane</h2>
      <p className={styles.hint}>Konfiguracja zapisuje się automatycznie w tej przeglądarce. Eksport tworzy plik, który możesz wczytać na innym komputerze.</p>
      <div className={styles.actions}>
        <button type="button" onClick={exportJson}>Eksportuj do pliku</button>
        <button type="button" onClick={() => fileInput.current?.click()}>Wczytaj z pliku</button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={e => { void importJson(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" className={styles.secondary} onClick={() => {
          if (window.confirm('Przywrócić ustawienia domyślne? Twoje ceny i koszty w tej przeglądarce zostaną zastąpione.')) { setConfig(defaultConfig()); setMessage('Przywrócono ustawienia domyślne.'); }
        }}>Przywróć domyślne</button>
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  </div>;
}
