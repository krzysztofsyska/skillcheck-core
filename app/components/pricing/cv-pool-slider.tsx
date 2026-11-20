"use client";

import { useId, useState } from "react";
import { sliderView, stepCvPool, type SliderPackage } from "../../../lib/pricing/cv-pool-slider-model.ts";
import styles from "./cv-pool-slider.module.css";

/**
 * Suwak i pole ręczne dzielą jeden stan (`value`), więc zawsze pokazują to samo.
 * Granice, krok i ceny przychodzą z katalogu przez `pkg`; cena jest przeliczana
 * z katalogu przy każdej zmianie, a pole formularza nigdy jej nie ustala.
 */
export function CvPoolSlider({ pkg }: { pkg: SliderPackage }) {
  const id = useId();
  const [value, setValue] = useState(pkg.min);
  const [draft, setDraft] = useState(String(pkg.min));
  const [note, setNote] = useState<string | null>(null);
  const view = sliderView(value, pkg);
  const top = pkg.min + Math.floor((pkg.max - pkg.min) / pkg.step) * pkg.step;

  const apply = (next: unknown) => {
    const result = sliderView(next, pkg);
    setValue(result.value);
    setDraft(String(result.value));
    setNote(result.message);
  };

  return <div className={styles.box}>
    <h3>{pkg.name}</h3>
    {!pkg.sellable && <p className={styles.unavailable}>Nie można jeszcze kupić. Cena orientacyjna.</p>}
    {pkg.adjustable
      ? <>
        <label htmlFor={`${id}-range`}>Liczba CV: {view.value}</label>
        <div className={styles.row}>
          <button type="button" aria-label="Zmniejsz liczbę CV" disabled={value <= pkg.min}
            onClick={() => apply(stepCvPool(value, -1, pkg))}>−</button>
          <input id={`${id}-range`} type="range" min={pkg.min} max={top} step={pkg.step} value={view.value}
            aria-valuetext={view.grossLabel ? `${view.value} CV, ${view.grossLabel} brutto` : `${view.value} CV`}
            onChange={event => apply(event.target.value)} />
          <button type="button" aria-label="Zwiększ liczbę CV" disabled={value >= top}
            onClick={() => apply(stepCvPool(value, 1, pkg))}>+</button>
        </div>
        <label htmlFor={`${id}-number`}>Wpisz liczbę CV (co {pkg.step})</label>
        <input id={`${id}-number`} className={styles.number} type="text" inputMode="numeric" autoComplete="off"
          value={draft} aria-describedby={`${id}-note`}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => apply(draft)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); apply(draft); } }} />
      </>
      : <p>Pakiet sprzedawany w całości: {pkg.min} CV.</p>}
    <p id={`${id}-note`} role="status" aria-live="polite" className={styles.note}>{note ?? ""}</p>
    <p className={styles.price} aria-live="polite">
      {view.grossLabel
        ? <>Cena: <strong>{view.grossLabel}</strong> brutto ({view.netLabel} netto)</>
        : "Cena chwilowo niedostępna."}
    </p>
  </div>;
}
