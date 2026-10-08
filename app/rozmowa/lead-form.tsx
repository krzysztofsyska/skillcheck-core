"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { submitLead, type LeadState, type LeadInput } from "./actions";
import styles from "./rozmowa.module.css";

const initial: LeadState = { status: "idle", message: "", retry: null };
const empty = { first_name: "", company_name: "", email: "", phone: "", needs: "" };

export function LeadForm({ notice }: { notice: string }) {
  const [fields, setFields] = useState(empty);
  const attempt = useRef<{ raw: string; key: string } | null>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const [state, action, pending] = useActionState(async (previous: LeadState, form: FormData) => {
    const values = Object.fromEntries(Object.keys(empty).map(name => [name, String(form.get(name) ?? "")])) as typeof empty;
    const raw = JSON.stringify(values);
    if (!attempt.current || attempt.current.raw !== raw) attempt.current = { raw, key: crypto.randomUUID() };
    try {
      const next = await submitLead(previous, { ...values, idempotency_key: attempt.current.key } satisfies LeadInput);
      // On conflict discard the candidate as well as the server-normalized retry key.
      if (next.status === "error" && !next.retry) attempt.current = null;
      return next;
    } catch {
      // A lost response must preserve the candidate UUID: the RPC might have committed.
      return { ...previous, status: "error" as const, message: "Nie udało się zapisać zgłoszenia. Dane zostały w formularzu. Możesz spróbować ponownie." };
    }
  }, initial);
  useEffect(() => { if (state.status !== "idle") feedback.current?.focus(); }, [state]);

  return (
    <div className={styles.panel}>
      {state.message && <p ref={feedback} tabIndex={-1} role={state.status === "success" ? "status" : "alert"} className={styles.feedback}>{state.message}</p>}
      {state.status !== "success" && <form action={action} aria-busy={pending}>
        <fieldset disabled={pending} className={styles.fields}>
          <legend className={styles.legend}>Dane do kontaktu</legend>
          <p>Wszystkie pola poza telefonem są wymagane.</p>
          <label htmlFor="lead-first-name">Imię</label>
          <input id="lead-first-name" name="first_name" autoComplete="given-name" required maxLength={80} value={fields.first_name} onChange={e => setFields({ ...fields, first_name: e.target.value })} />
          <label htmlFor="lead-company">Firma</label>
          <input id="lead-company" name="company_name" autoComplete="organization" required maxLength={160} value={fields.company_name} onChange={e => setFields({ ...fields, company_name: e.target.value })} />
          <label htmlFor="lead-email">E-mail</label>
          <input id="lead-email" name="email" type="email" autoComplete="email" required maxLength={254} value={fields.email} onChange={e => setFields({ ...fields, email: e.target.value })} />
          <label htmlFor="lead-phone">Telefon (opcjonalnie)</label>
          <input id="lead-phone" name="phone" type="tel" autoComplete="tel" minLength={5} maxLength={32} value={fields.phone} onChange={e => setFields({ ...fields, phone: e.target.value })} />
          <label htmlFor="lead-needs">O jakiej rekrutacji chcesz porozmawiać?</label>
          <textarea id="lead-needs" name="needs" required minLength={10} maxLength={1000} rows={6} aria-describedby="lead-help" value={fields.needs} onChange={e => setFields({ ...fields, needs: e.target.value })} />
          <p id="lead-help">Opisz krótko potrzeby firmy (10–1000 znaków). Nie podawaj danych kandydatów ani treści CV.</p>
          <p className={styles.notice}>{notice}</p>
          <button type="submit">{pending ? "Zapisuję zgłoszenie…" : "Wyślij zgłoszenie"}</button>
        </fieldset>
        <noscript>Do wysłania formularza potrzebne jest włączenie JavaScript.</noscript>
      </form>}
    </div>
  );
}
