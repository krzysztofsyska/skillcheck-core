"use client";
import { useState } from "react";
import { formatGross } from "../../../lib/pricing/cv-pool";
import { MAX_OPTION_QUANTITY, priceSelection, type PaidOption } from "../../../lib/pricing/paid-options";
import styles from "../../marketing.module.css";

// SC-PRICING-W3. Ceny i stawka VAT przychodzą z katalogu (props z serwera); komponent niczego nie
// wysyła i nie składa zamówienia. Suma liczona jest tą samą funkcją, której użyje serwer.
export function PaidOptionsPicker({ options, vatBasisPoints }: { options: PaidOption[]; vatBasisPoints: number }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const price = priceSelection(quantities, options, vatBasisPoints);
  const set = (code: string, raw: string) => {
    const n = Math.floor(Number(raw));
    setQuantities(prev => ({ ...prev, [code]: Number.isFinite(n) && n > 0 ? Math.min(n, MAX_OPTION_QUANTITY) : 0 }));
  };
  return <section aria-labelledby="paid-options-title">
    <h2 id="paid-options-title">Opcje dodatkowe do wyboru</h2>
    <p>Wybierz, czego potrzebujesz ponad pakiet. Ceny są brutto, za jedną sztukę, i pochodzą z aktualnego cennika.</p>
    <ul>
      {options.map(o => <li key={o.code}>
        <label>
          <strong>{o.name}</strong> — {formatGross(o.grossMinor)} za {o.unit}{" "}
          <input type="number" inputMode="numeric" min={0} max={MAX_OPTION_QUANTITY} step={1}
            value={quantities[o.code] ?? 0} onChange={e => set(o.code, e.target.value)}
            aria-label={`Liczba: ${o.name}`} />
        </label>
      </li>)}
    </ul>
    <p aria-live="polite"><strong>Razem za opcje: {formatGross(price.grossMinor)} brutto</strong>
      {price.netMinor > 0 ? ` (${formatGross(price.netMinor)} netto + VAT ${formatGross(price.vatMinor)})` : ""}</p>
    <p className={styles.note}>To wycena orientacyjna. Niczego tu nie zamawiasz ani nie płacisz — zamówienie dodatków ustalamy z obsługą, a kwota jest liczona z cennika w chwili zamówienia, nie z tego formularza.</p>
  </section>;
}
