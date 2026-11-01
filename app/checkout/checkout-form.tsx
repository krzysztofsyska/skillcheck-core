"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import css from "./checkout.module.css";
import { formatPln } from "../../lib/checkout-catalog";

type Product = { code: string; name: string; description: string; unitGross: number; maxQuantity: number };

const FIELD_MESSAGES: Record<string, string> = {
  product: "Wybrany produkt jest niedostępny.",
  quantity: "Podaj prawidłową ilość.",
  name: "Podaj imię i nazwisko.",
  email: "Podaj prawidłowy adres e-mail.",
  phone: "Podaj prawidłowy numer telefonu.",
  company: "Sprawdź nazwę firmy.",
  nip: "Podaj prawidłowy NIP (10 cyfr) albo zostaw pole puste.",
  terms: "Zaakceptuj regulamin i politykę prywatności, aby przejść do płatności.",
};

export function CheckoutForm({ product, initialQuantity, enabled }: { product: Product; initialQuantity: number; enabled: boolean }) {
  const [quantity, setQuantity] = useState(initialQuantity);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = product.unitGross * quantity;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "");
    if (form.get("terms") !== "on") { setError(FIELD_MESSAGES.terms); return; }
    if (!enabled) { setError("Płatność online będzie dostępna wkrótce. Do tego czasu możesz zamówić pakiet na podstawie faktury proforma."); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/p24/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product: product.code, quantity, name: text("name"), email: text("email"), phone: text("phone"),
          company: text("company"), nip: text("nip"), terms: true }),
      });
      const data = await response.json().catch(() => ({})) as { redirectUrl?: string; error?: string; field?: string };
      if (response.ok && typeof data.redirectUrl === "string" && data.redirectUrl.startsWith("https://")) {
        window.location.assign(data.redirectUrl);
        return;
      }
      setError(data.field && FIELD_MESSAGES[data.field] ? FIELD_MESSAGES[data.field]
        : data.error === "CHECKOUT_RATE_LIMITED" ? "Zbyt wiele prób zamówienia. Spróbuj ponownie za godzinę."
        : "Nie udało się rozpocząć płatności. Spróbuj ponownie za chwilę albo poproś o fakturę proforma.");
    } catch {
      setError("Brak połączenia. Sprawdź internet i spróbuj ponownie.");
    }
    setBusy(false);
  }

  return <div className={css.layout}>
    <form className={`${css.form} ${css.card}`} onSubmit={submit} noValidate={false}>
      <fieldset className={css.fieldset}>
        <legend>Dane kupującego</legend>
        <label>Imię i nazwisko
          <input name="name" autoComplete="name" required minLength={2} maxLength={120} />
        </label>
        <div className={css.row}>
          <label>E-mail
            <input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          <label>Telefon
            <input name="phone" type="tel" autoComplete="tel" required minLength={6} maxLength={32} />
          </label>
        </div>
      </fieldset>
      <fieldset className={css.fieldset}>
        <legend>Dane do faktury <span className={css.optional}>(opcjonalnie)</span></legend>
        <div className={css.row}>
          <label>Firma
            <input name="company" autoComplete="organization" maxLength={200} />
          </label>
          <label>NIP
            <input name="nip" inputMode="numeric" maxLength={13} pattern="(PL)?[0-9\- ]{10,13}" />
          </label>
        </div>
      </fieldset>
      <label className="consent">
        <input type="checkbox" name="terms" required />
        <span>Akceptuję <Link href="/regulamin" target="_blank">regulamin</Link> i <Link href="/polityka-prywatnosci" target="_blank">politykę prywatności</Link>. <span aria-hidden="true">*</span></span>
      </label>

      <div className={css.payment} aria-labelledby="payment-title">
        <h2 id="payment-title">Płatność</h2>
        {/* Official Przelewy24 logo, served locally (CSP img-src 'self'). */}
        <img className={css.logo} src="/payments/przelewy24.svg" alt="Przelewy24" width={180} height={63} />
        <ul className={css.methods} aria-label="Dostępne metody płatności">
          <li>BLIK</li>
          <li>Szybki przelew</li>
          <li>Karta płatnicza</li>
        </ul>
        <p className={css.small}>Bez dodatkowych opłat za wybraną metodę płatności. Metodę wybierzesz na stronie Przelewy24.
          Płatności online obsługuje PayPro S.A. (Przelewy24).</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        <button className={css.pay} type="submit" disabled={busy}>
          {busy ? "Przekierowuję do Przelewy24…" : `Zamawiam i płacę ${formatPln(total)}`}
        </button>
      </div>
    </form>

    <aside className={`${css.card} ${css.summaryCard}`} aria-labelledby="summary-title">
      <h2 id="summary-title">Podsumowanie zamówienia</h2>
      <table className={css.summary}>
        <thead>
          <tr><th scope="col">Nazwa</th><th scope="col" className={css.num}>Ilość</th><th scope="col" className={css.num}>Cena brutto</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>{product.name}</strong><br /><span className={css.small}>{product.description}</span></td>
            <td className={css.num}>
              <input className={css.qty} type="number" min={1} max={product.maxQuantity} value={quantity} aria-label="Ilość"
                onChange={e => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= product.maxQuantity) setQuantity(n); }} />
            </td>
            <td className={css.num}>{formatPln(product.unitGross)}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr><td colSpan={2}>Suma do zapłaty</td><td className={css.num} data-testid="checkout-total">{formatPln(total)}</td></tr>
        </tfoot>
      </table>
      <p className={css.small}>Kwoty brutto, zawierają 23% VAT. Waluta: PLN.</p>
    </aside>
  </div>;
}
