import {
  VOICE_OWNER_ALERT_CAUSES, formatGrosze, formatVoiceMonth, formatVoiceTime, voiceCallsLeft, type VoiceCostCapView,
} from '../../../lib/voice/cost-cap-operator';
import styles from '../sales/sales.module.css';
import own from './ai-costs.module.css';

/** R7: the monthly voice cost cap and the owner alerts, operator only (rendered by the
 * operator-gated /operator/ai-costs page; the data comes from operator-gated functions).
 * Shown in the panel only; nothing is sent by e-mail, SMS or any other channel. */
export function VoiceCostCapSection({ view }: { view: VoiceCostCapView }) {
  return <section className={styles.card} aria-labelledby="voice-cap">
    <h2 id="voice-cap">Limit kosztu rozmów voicebota</h2>
    <p className={styles.hint}>Miesięczny limit kosztu rozmów głosowych (decyzja z 19.11.2026). Widok wewnętrzny — firmy go nie widzą.
      Powiadomienie o wyczerpaniu limitu jest widoczne tylko tutaj; nic nie jest wysyłane e-mailem ani SMS-em.</p>
    {view.state === 'unavailable' ? <p className={styles.empty}>Nie udało się odczytać limitu rozmów voicebota. Odśwież stronę.</p> : <>
      <ul>
        <li>Miesiąc: <strong>{formatVoiceMonth(view.status.month)}</strong></li>
        <li>Limit miesięczny: <strong>{formatGrosze(view.status.capGrosze)}</strong></li>
        <li>Koszt od początku miesiąca: <strong>{formatGrosze(view.status.monthToDateGrosze)}</strong>
          {' '}(rozliczone {formatGrosze(view.status.recordedCostGrosze)}, rezerwy rozmów bez rozliczenia {formatGrosze(view.status.inFlightGrosze)})</li>
        <li>Zostało: <strong>{formatGrosze(view.status.remainingGrosze)}</strong>
          {' '}<span className={styles.hint}>(każda rozmowa rezerwuje {formatGrosze(view.status.callReserveGrosze)} przed zleceniem)</span></li>
        <li>Nowe rozmowy: {view.status.newCallsBlocked
          ? <strong className={own.status} data-status="unavailable">wstrzymane do 1. dnia następnego miesiąca</strong>
          : <strong className={own.status} data-status="confirmed">można zlecać (zmieszczą się jeszcze {voiceCallsLeft(view.status)})</strong>}</li>
        {view.status.reserveExceeded && <li><strong>Rozmowa kosztowała więcej niż zarezerwowana kwota — trzeba sprawdzić stawki dostawcy.</strong></li>}
        <li>Alert dla właściciela w tym miesiącu: {view.status.alertRecordedAt
          ? <strong>zapisany {formatVoiceTime(view.status.alertRecordedAt)}</strong> : 'brak'}</li>
      </ul>
      <h3>Zapisane alerty dla właściciela</h3>
      {!view.alerts.length ? <p className={styles.empty}>Limit nie został jeszcze wyczerpany — brak alertów.</p> :
        <div className={own.scroll}><table className={own.table}>
          <thead><tr><th scope="col">Miesiąc</th><th scope="col">Przyczyna</th><th scope="col">Koszt w chwili alertu</th>
            <th scope="col">Limit</th><th scope="col">Zapisano</th></tr></thead>
          <tbody>{view.alerts.map(alert => <tr key={alert.month}>
            <th scope="row">{formatVoiceMonth(alert.month)}</th>
            <td>{VOICE_OWNER_ALERT_CAUSES[alert.cause]}</td>
            <td>{formatGrosze(alert.monthToDateGrosze)}</td>
            <td>{formatGrosze(alert.capGrosze)}</td>
            <td>{formatVoiceTime(alert.recordedAt)}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
  </section>;
}
