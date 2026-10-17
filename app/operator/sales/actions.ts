'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '../../../lib/supabase/server';
import { parsePipelineForm } from '../../../lib/sales-pipeline';
export type PipelineState = { message: string; done: boolean };
export async function savePipeline(_state: PipelineState, form: FormData): Promise<PipelineState> {
  const input = parsePipelineForm(form);
  const failure = { message: 'Nie udało się zapisać. Sprawdź dane i uprawnienia, a następnie spróbuj ponownie.', done: false };
  if (!input) return failure;
  try {
    const client = await createClient();
    const { data: { user }, error: authError } = await client.auth.getUser();
    if (authError || !user) return failure;
    const { data, error } = await client.rpc('save_sales_pipeline', input);
    if (error) return failure;
    if (data === 'conflict') return { done: false, message: 'Ktoś zmienił to zgłoszenie. Skopiuj swoją notatkę i odśwież stronę przed kolejnym zapisem.' };
    if (data === 'company_required') return { done: false, message: 'Przed oznaczeniem wygranej wybierz firmę klienta.' };
    if (data === 'company_not_found') return { done: false, message: 'Wybrana firma już nie istnieje. Wyszukaj ją ponownie.' };
    if (data === 'closed') return { done: false, message: 'To zgłoszenie jest już zakończone. Odśwież stronę.' };
    if (data !== 'ok') return failure;
    revalidatePath('/operator/sales'); revalidatePath('/operator/sales/' + input.target_lead); revalidatePath('/operator/leads');
    return { message: 'Zmiany zapisane.', done: true };
  } catch { return failure; }
}
