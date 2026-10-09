"use client";

import { useActionState } from "react";
import { closeLead } from "./actions";
import styles from "./leads.module.css";

export function CloseLeadForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(closeLead, { message: "", done: false });
  return <details className={styles.close}>
    <summary>Zakończ rozmowę bez zawarcia umowy</summary>
    <form action={action}>
      <input type="hidden" name="lead_id" value={id} />
      <label><input type="checkbox" name="confirm" value="yes" required disabled={pending || state.done} />
        Potwierdzam zakończenie rozmów. Dane tego zgłoszenia zostaną usunięte po 6 miesiącach.</label>
      <button type="submit" disabled={pending || state.done}>{pending ? "Zapisywanie…" : "Potwierdź zakończenie"}</button>
      {state.message && <p role="status">{state.message}</p>}
    </form>
  </details>;
}
