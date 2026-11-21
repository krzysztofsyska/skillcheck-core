/**
 * R7: the voice cost cap and its owner alerts, as the platform operator sees them
 * in /operator/ai-costs (owner decision 19.11.2026, docs/DECYZJE.md).
 *
 * Read only, through two operator-gated database functions
 * (supabase/migrations/20261121140000_r7_voice_cost_cap_operator_view.sql), which
 * re-check the operator allowlist and return amounts and months only. Nothing here
 * sends anything: the alert is shown in the panel, no e-mail, SMS or other channel.
 * Never used by customer-facing pages (voicebot info is not shown to customers).
 */

export const VOICE_OWNER_ALERTS_LIMIT = 12;

export type VoiceCapStatus = {
  month: string;
  capGrosze: number;
  callReserveGrosze: number;
  recordedCostGrosze: number;
  inFlightGrosze: number;
  monthToDateGrosze: number;
  remainingGrosze: number;
  newCallsBlocked: boolean;
  reserveExceeded: boolean;
  alertRecordedAt: string | null;
};

export type VoiceOwnerAlertCause = 'dispatch' | 'call_cost' | 'reserve_exceeded';

export type VoiceOwnerAlert = {
  month: string;
  cause: VoiceOwnerAlertCause;
  capGrosze: number;
  monthToDateGrosze: number;
  recordedAt: string;
};

/** What the panel renders; `unavailable` when the read failed or returned something unexpected. */
export type VoiceCostCapView =
  | { state: 'ready'; status: VoiceCapStatus; alerts: VoiceOwnerAlert[] }
  | { state: 'unavailable' };

/** Plain Polish for the operator; one line per database cause. */
export const VOICE_OWNER_ALERT_CAUSES: Record<VoiceOwnerAlertCause, string> = {
  dispatch: 'Zlecona rozmowa zajęła ostatnie miejsce w limicie — kolejnych rozmów w tym miesiącu nie da się zlecić.',
  call_cost: 'Rzeczywisty koszt rozmowy wyczerpał limit — kolejnych rozmów w tym miesiącu nie da się zlecić.',
  reserve_exceeded: 'Rozmowa kosztowała więcej niż kwota zarezerwowana na jedną rozmowę — nowe rozmowy wstrzymane do końca miesiąca. Trzeba sprawdzić stawki dostawcy.',
};

const MONTH = /^\d{4}-\d{2}-01$/;
const amount = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^-?\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const timestamp = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
const month = (value: unknown): string | null => (typeof value === 'string' && MONTH.test(value) ? value : null);

/** One row of public.r7_operator_voice_cost_cap(); null when anything is missing or malformed. */
export function parseVoiceCapStatus(rows: unknown): VoiceCapStatus | null {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') return null;
  const r = rows[0] as Record<string, unknown>;
  const numbers = {
    capGrosze: amount(r.cap_grosze), callReserveGrosze: amount(r.call_reserve_grosze),
    recordedCostGrosze: amount(r.recorded_cost_grosze), inFlightGrosze: amount(r.in_flight_grosze),
    monthToDateGrosze: amount(r.month_to_date_grosze), remainingGrosze: amount(r.remaining_grosze),
  };
  const m = month(r.month);
  if (!m || Object.values(numbers).some(v => v === null)) return null;
  if (typeof r.new_calls_blocked !== 'boolean' || typeof r.reserve_exceeded !== 'boolean') return null;
  const alertRecordedAt = r.alert_recorded_at === null ? null : timestamp(r.alert_recorded_at);
  if (r.alert_recorded_at !== null && alertRecordedAt === null) return null;
  return {
    month: m, ...(numbers as { [K in keyof typeof numbers]: number }),
    newCallsBlocked: r.new_calls_blocked, reserveExceeded: r.reserve_exceeded, alertRecordedAt,
  };
}

/** Rows of public.r7_operator_voice_owner_alerts(); null when any row is malformed. */
export function parseVoiceOwnerAlerts(rows: unknown): VoiceOwnerAlert[] | null {
  if (!Array.isArray(rows) || rows.length > 120) return null;
  const alerts: VoiceOwnerAlert[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    const m = month(r.month), cap = amount(r.cap_grosze), total = amount(r.month_to_date_grosze), at = timestamp(r.recorded_at);
    if (!m || cap === null || total === null || !at || typeof r.cause !== 'string'
      || !Object.hasOwn(VOICE_OWNER_ALERT_CAUSES, r.cause)) return null;
    alerts.push({ month: m, cause: r.cause as VoiceOwnerAlertCause, capGrosze: cap, monthToDateGrosze: total, recordedAt: at });
  }
  return alerts;
}

/** Grosze to "50,00 zł" without floating point. */
export function formatGrosze(grosze: number): string {
  const whole = Math.trunc(grosze / 100);
  return `${whole.toLocaleString('pl-PL')},${String(grosze % 100).padStart(2, '0')} zł`;
}

const monthNames = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const times = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' });

/** "2026-11-01" -> "listopad 2026". */
export const formatVoiceMonth = (value: string): string => monthNames.format(new Date(`${value}T00:00:00Z`));
/** Polish date and time in Europe/Warsaw. */
export const formatVoiceTime = (value: string): string => times.format(new Date(value));

/** How many more calls fit this month (each reserves its upper bound before it is ordered). */
export function voiceCallsLeft(status: VoiceCapStatus): number {
  if (status.newCallsBlocked || status.callReserveGrosze <= 0) return 0;
  return Math.floor(status.remainingGrosze / status.callReserveGrosze);
}

type RpcResult = { data: unknown; error: { code?: string } | null };
type VoiceCapRpc = 'r7_operator_voice_cost_cap' | 'r7_operator_voice_owner_alerts';
// Method syntax: the typed Supabase client's generic rpc() is accepted for these two names.
type OperatorClient = { rpc(name: VoiceCapRpc, args?: { result_limit: number }): PromiseLike<RpcResult> };

/**
 * Reads both functions with the operator's own logged-in client. A 42501 (not an
 * operator) is returned as `forbidden` so the page can answer 404; any other error
 * (e.g. the migration not applied yet) is `unavailable`, never a crash of the panel.
 */
export async function loadVoiceCostCap(client: OperatorClient): Promise<VoiceCostCapView | 'forbidden'> {
  const [status, alerts] = await Promise.all([
    client.rpc('r7_operator_voice_cost_cap'),
    client.rpc('r7_operator_voice_owner_alerts', { result_limit: VOICE_OWNER_ALERTS_LIMIT }),
  ]);
  if (status.error?.code === '42501' || alerts.error?.code === '42501') return 'forbidden';
  if (status.error || alerts.error) return { state: 'unavailable' };
  const parsedStatus = parseVoiceCapStatus(status.data);
  const parsedAlerts = parseVoiceOwnerAlerts(alerts.data);
  if (!parsedStatus || !parsedAlerts) return { state: 'unavailable' };
  return { state: 'ready', status: parsedStatus, alerts: parsedAlerts };
}
