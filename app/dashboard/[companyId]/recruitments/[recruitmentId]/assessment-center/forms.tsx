'use client';
import { useActionState, type ReactNode } from 'react';
import type { AcSessionActionState } from './actions';

type Action = (previous: AcSessionActionState, form: FormData) => Promise<AcSessionActionState>;

/** One native form per append-only write. A failed save keeps what was typed;
 * after a successful one the fields lock until the refreshed page replaces the form. */
export function AcSessionForm({ action, legend, button, saved, children }: {
  action: Action; legend: string; button: string; saved: string; children?: ReactNode;
}) {
  const [state, submit, pending] = useActionState(action, {});
  return <form action={submit} onReset={event => event.preventDefault()}>
    {state.error && <p role="alert">{state.error}</p>}
    {state.saved && <p role="status">{saved}</p>}
    <fieldset disabled={pending || state.saved}><legend>{legend}</legend>
      {children}
      <button>{pending ? 'Zapisywanie…' : button}</button>
    </fieldset>
  </form>;
}
