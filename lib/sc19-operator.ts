/** Form parsing and result codes for the SC-019 operator billing panel.
 * The database re-checks the operator role and every value; this only keeps
 * malformed input away from the RPC and maps its errors to panel notices. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

export const sc19OperatorNotices = {
  policy_saved: 'Liczba analiz w pakiecie zapisana. Dotyczy kolejnych aktywacji i przydziałów.',
  trial_approved: 'Firma zweryfikowana. Właściciel może teraz aktywować FREE w zakładce Pakiety.',
  paid_granted: 'Pakiet PRESELEKCJA przydzielony. Ponowne użycie tego samego numeru rozliczenia nic nie doda.',
  invalid: 'Sprawdź dane formularza.',
  invalid_nip: 'NIP jest nieprawidłowy (10 cyfr z poprawną sumą kontrolną).',
  conflict: 'Konflikt: ten NIP jest już przypisany do innej firmy albo firma ma zatwierdzony inny NIP.',
  reference_conflict: 'Ten numer rozliczenia został już użyty dla innej firmy.',
  missing_policy: 'Najpierw ustaw liczbę analiz w pakiecie PRESELEKCJA.',
  confirm: 'Zaznacz potwierdzenie przed zapisem.',
  failed: 'Operacja nie powiodła się. Odśwież stronę i spróbuj ponownie.',
} as const;
export type Sc19OperatorNotice = keyof typeof sc19OperatorNotices;

export function parsePolicyForm(form: FormData) {
  const plan = text(form, 'plan');
  const credits = Number(text(form, 'credits'));
  if ((plan !== 'FREE' && plan !== 'PRESELEKCJA') || !Number.isInteger(credits) || credits < 1 || credits > 100000) return null;
  return { target_plan: plan, target_credits: credits } as const;
}

export function parseTrialForm(form: FormData) {
  const company = text(form, 'companyId');
  const nip = text(form, 'nip').replace(/[\s-]/g, '');
  const proof = text(form, 'proof');
  if (!uuidPattern.test(company) || !/^[0-9]{10}$/.test(nip) || proof.length < 8 || proof.length > 100) return null;
  return { target_company: company, supplied_nip: nip, proof };
}

export function parseGrantForm(form: FormData) {
  const company = text(form, 'companyId');
  const reference = text(form, 'settlement');
  if (!uuidPattern.test(company) || reference.length < 8 || reference.length > 160) return null;
  return { target_company: company, settlement_reference: reference };
}

export function sc19OperatorError(error: { code?: string; message?: string }): Sc19OperatorNotice {
  const message = error.message ?? '';
  if (message.includes('sc19_invalid_nip')) return 'invalid_nip';
  if (message.includes('sc19_reference_conflict')) return 'reference_conflict';
  if (message.includes('sc19_missing_paid_policy')) return 'missing_policy';
  if (error.code === '23505') return 'conflict';
  if (error.code === '22023') return 'invalid';
  return 'failed';
}
