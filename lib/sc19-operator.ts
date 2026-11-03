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
  auto_free_saved: 'Ustawienie automatycznego FREE zapisane. Dotyczy kolejnych aktywacji.',
  nip_released: 'NIP zwolniony. Firma, która go naprawdę reprezentuje, może teraz aktywować FREE. Przyznanych analiz nie odebrano.',
  nip_not_taken: 'Ten NIP nie jest zajęty — nie ma czego zwalniać.',
  release_reason: 'Podaj powód zwolnienia (8–300 znaków): co sprawdzono i kiedy.',
  nip_holder_changed: 'Nic nie zmieniono. Ten NIP w międzyczasie przeszedł do innej firmy niż ta, którą sprawdzałeś — strona była nieaktualna. Odśwież stronę, sprawdź firmę jeszcze raz i dopiero wtedy zwolnij NIP.',
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

/** Releasing an occupied trial NIP. The reason is mandatory and is stored in the
 * audit, so "why was this NIP freed" always has an answer.
 *
 * `companyId` is the company the operator was LOOKING AT when he opened the
 * form, and it is sent with it. The page can be minutes old by then, and in the
 * meantime the NIP may have moved to the company that really owns it; releasing
 * "whoever holds this NIP now" would then punish that company instead. The
 * database refuses the release unless this company still holds the NIP, so the
 * decision stays attached to what was actually verified. */
export function parseReleaseForm(form: FormData) {
  const company = text(form, 'companyId');
  const nip = text(form, 'nip').replace(/[\s-]/g, '');
  const reason = text(form, 'reason');
  if (!uuidPattern.test(company) || !/^[0-9]{10}$/.test(nip)
    || reason.length < 8 || reason.length > 300) return null;
  return { supplied_nip: nip, release_reason: reason, expected_company: company };
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
  if (message.includes('sc19_trial_nip_not_taken')) return 'nip_not_taken';
  // The page the operator submitted from was stale: another company holds the
  // NIP now, so nothing was released. Checked before the generic 22023 mapping,
  // which would otherwise swallow it into "Sprawdź dane formularza".
  if (message.includes('sc19_trial_nip_holder_changed')) return 'nip_holder_changed';
  if (message.includes('sc19_release_company_required')) return 'nip_holder_changed';
  if (message.includes('sc19_release_reason_required')) return 'release_reason';
  if (error.code === '23505') return 'conflict';
  if (error.code === '22023') return 'invalid';
  return 'failed';
}
