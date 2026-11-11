'use client';
import { useEffect, useState } from 'react';
import { sc19OfferAmounts } from '../../../../../lib/sc19-offer-amounts';
type Offer={id:string;revision:string;amountMinor:number;currency:string;credits:number;
  termsRevision:string;termsText:string;validUntilMs:number;
  netMinor?:number|null;vatMinor?:number|null;vatBasisPoints?:number|null};
const pln=(v:number)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(v/100);
// Gross is authoritative: it is what the server charges and what a settlement is
// matched against. Net and VAT are derived from it; the server sends them, and the
// same shared formula is the fallback so the two can never disagree.
const breakdown=(offer: Offer)=>typeof offer.netMinor==='number'&&typeof offer.vatMinor==='number'
  ?{netMinor:offer.netMinor,vatMinor:offer.vatMinor,vatBasisPoints:offer.vatBasisPoints ?? null}
  :sc19OfferAmounts(offer.amountMinor);
const verificationPending='Twoja firma czeka na weryfikację — do tego czasu zakupu nie można złożyć. Odświeżenie strony tego nie zmieni. Napisz do nas przez formularz kontaktowy (/rozmowa) albo na pomoc@skillcheck.pl, a potwierdzimy firmę i odblokujemy zamówienie.';
const paymentsPending='Płatność online jest w trakcie uruchamiania (trwa weryfikacja u operatora płatności Przelewy24). Zamówienia nie można jeszcze złożyć — cena i warunki poniżej są wiążące i nie zmienią się po włączeniu płatności.';
// The sandbox runs on the production domain too, so that a Przelewy24 verifier can
// pay with test money (owner decision 2026-11-11). Nothing is charged, but the
// analyses ARE granted on this account, which is exactly what makes the walk
// meaningful — so the screen says both, and promises no payment method of its own
// beyond what the operator's sandbox offers.
const sandboxNotice='Płatność testowa w Sandboxie Przelewy24: żadne pieniądze nie zostaną pobrane. Analizy CV zostaną jednak przyznane na tym koncie tak samo jak po zwykłym zakupie.';
/** A failure we have no dedicated sentence for. The code is shown on purpose: it
 * is the only thing that tells support whether to retry or to look at the payment
 * operator, and it contains no private data. */
const checkoutFailed=(code:string)=>
  `Nie udało się otworzyć płatności. Ponów próbę — serwer sprawdzi istniejące zamówienie. Jeśli to się powtarza, napisz na pomoc@skillcheck.pl i podaj kod: ${code}.`;
/** Optional Przelewy24 failure code from the server, e.g. P24_UNAUTHORIZED. Only a
 * fixed-format code is ever rendered, never anything else the response carries. */
const p24Detail=(value:unknown)=>typeof value==='string'&&/^P24_[A-Z_]{3,40}$/.test(value)?value:null;
const reconciliationRequired='Tego zamówienia nie można już otworzyć ani potwierdzić automatycznie. Ponawianie nie pomoże. Napisz na pomoc@skillcheck.pl, podaj nazwę firmy — odblokujemy zamówienie i będziesz mógł złożyć nowe.';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const contextKey = (companyId: string, orderId: string) => `sc19:recruitment:${companyId.toLowerCase()}:${orderId.toLowerCase()}`;
export default function Checkout({companyId,recruitmentId,sandbox=false,statusOnly=false}: {companyId:string;recruitmentId?:string;sandbox?:boolean;statusOnly?:boolean}) {
  const [offers,setOffers]=useState<Offer[]>([]),[selected,setSelected]=useState('');
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [checkoutAvailable,setCheckoutAvailable]=useState(true);
  const [orderId,setOrderId]=useState(''),[paidOrder,setPaidOrder]=useState<{offerId:string;termsRevision:string}|null>(null);
  const [requestIds]=useState(()=>new Map<string,string>());
  const [returnedRecruitment,setReturnedRecruitment]=useState<string|null>(null);
  const offer=offers.find(o=>o.id===selected);
  const amounts=offer&&breakdown(offer);
  async function loadOffers(signal?: AbortSignal) {
    setLoading(true);setAccepted(false);setOffers([]);setSelected('');
    try {
      const r=await fetch(`/api/billing/offers?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store',signal});
      if(!r.ok){
        // The offer read itself can be unavailable: no payment provider AND no
        // catalog (SC19_PACKAGES_ENABLED off). Say so with the same wording the
        // refused purchase uses, instead of "could not load", which would suggest
        // retrying would help.
        const failure=await r.json().catch(()=>null);
        if(failure?.error==='SC19_PAYMENTS_DISABLED'){
          if(!signal?.aborted){setCheckoutAvailable(false);setMessage(paymentsPending);}
          return;
        }
        // A brand-new company has no approval yet, so the offer read is refused.
        // Refreshing can never help: what is missing is a verification only
        // SkillCheck can grant, so name the real next step instead.
        if(failure?.error==='SC19_PAYMENT_FORBIDDEN'){
          if(!signal?.aborted){setCheckoutAvailable(false);setMessage(verificationPending);}
          return;
        }
        throw Error();
      }
      const data=await r.json();
      if(!signal?.aborted){
        // Availability is never assumed: only an explicit true opens the pay button.
        setCheckoutAvailable(data.checkoutAvailable===true);
        setOffers(data.offers);setSelected(data.offers[0]?.id ?? '');
        if(data.checkoutAvailable!==true&&data.offers?.length>0)setMessage('');
      }
    } catch {
      if(!signal?.aborted){setCheckoutAvailable(false);
        setMessage('Nie udało się wczytać oferty. Odśwież stronę lub spróbuj ponownie za chwilę.');}
    } finally {if(!signal?.aborted)setLoading(false);}
  }
  useEffect(()=>{
    const abort=new AbortController();
    setReturnedRecruitment(null);
    if (!statusOnly) void loadOffers(abort.signal);
    const returned = sandbox && new URLSearchParams(window.location.search).get('p24');
    if (returned && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(returned)) {
      // Optional same-tab navigation hint, never payment evidence or an access grant.
      // The destination checks membership; storage can only supply a UUID, never a URL.
      if (uuid(companyId)) try {
        const saved = sessionStorage.getItem(contextKey(companyId, returned));
        setReturnedRecruitment(uuid(saved) ? saved.toLowerCase() : null);
      } catch { setReturnedRecruitment(null); }
      setOrderId(returned);
      try { sessionStorage.setItem(`sc19:order:${companyId}`, returned); } catch { /* optional */ }
      void status(returned);
    } else try { setOrderId(sessionStorage.getItem(`sc19:order:${companyId}`) ?? ''); } catch { /* unavailable storage: status can be retried in this session */ }
    return ()=>abort.abort();
  },[companyId,sandbox,statusOnly]);
  async function status(id=orderId) {
    if(!id)return;
    setBusy(true);
    try {
      const r=await fetch(`/api/billing/orders/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store',method:sandbox?'POST':'GET'});
      if(!r.ok)throw Error(); const data=await r.json();
      setPaidOrder(data.status==='paid'?{offerId:data.offerId,termsRevision:data.termsRevision}:null);
      setMessage(data.status==='paid' ? `Płatność potwierdzona. Przyznano ${data.credits} analiz CV.` :
        'Czekamy na potwierdzenie płatności. Kredyty zostaną przyznane po jej weryfikacji.');
    } catch {setMessage('Nie udało się sprawdzić statusu. Spróbuj ponownie.');}
    finally {setBusy(false);}
  }
  function nextPurchase() {
    if(!paidOrder||!offer)return;
    const key=`sc19:request:${companyId}:${paidOrder.offerId}:${paidOrder.termsRevision}`;
    requestIds.delete(key);
    try {
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`sc19:order:${companyId}`);
    } catch { /* Server-side order invariant does not depend on browser storage. */ }
    if (sandbox) {
      const url = new URL(window.location.href);
      url.searchParams.delete('p24');
      window.history.replaceState(window.history.state,'',url);
    }
    setOrderId('');setPaidOrder(null);setAccepted(false);setMessage('Możesz złożyć kolejne zamówienie.');
  }
  async function buy() {
    // Never post while checkout is unavailable: the server refuses it anyway
    // (SC19_PAYMENTS_DISABLED), and the button is rendered disabled.
    if(!offer||!accepted||busy||loading||paidOrder||!checkoutAvailable)return;
    setBusy(true);setMessage('');
    try {
      // Best-effort retry hint. The durable server invariant also protects new
      // tabs/devices and browsers where sessionStorage is missing or evicted.
      const key=`sc19:request:${companyId}:${offer.id}:${offer.termsRevision}`;
      let requestId=requestIds.get(key);
      try {requestId ??= sessionStorage.getItem(key) ?? undefined;} catch { /* optional */ }
      requestId ??= crypto.randomUUID();requestIds.set(key,requestId);
      try {sessionStorage.setItem(key,requestId);} catch { /* optional */ }
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({companyId,offerId:offer.id,termsRevision:offer.termsRevision,requestId})});
      // A killed invocation or a platform error answers with HTML, not JSON. Bare
      // `response.json()` threw here and every failure — including our own error
      // codes — fell into the generic catch below, which is why a broken checkout
      // could not be told apart from a provider outage without reading the database.
      const data=await response.json().catch(()=>null)??{};
      if(!response.ok){
        if(data.error==='SC19_PAYMENT_OFFER_UNAVAILABLE'){
          setMessage('Oferta wygasła lub zmieniły się jej warunki. Odświeżamy dostępne oferty. Sprawdź je i zaakceptuj ponownie.');
          await loadOffers();return;
        }
        if(data.error==='SC19_PAYMENT_PURCHASE_PENDING'){
          setMessage('Firma ma już nierozliczone zamówienie z innymi warunkami. Dokończ je lub skontaktuj się z obsługą przed kolejnym zakupem.');return;
        }
        if(data.error==='SC19_PAYMENTS_DISABLED'){
          setCheckoutAvailable(false);setMessage(paymentsPending);return;
        }
        // The order exists but its payment session can no longer be opened or
        // confirmed automatically. Retrying cannot help and the next purchase stays
        // blocked until we clear this one, so say that instead of "try again".
        if(data.error==='SC19_PAYMENT_RECONCILIATION_REQUIRED'){
          setMessage(reconciliationRequired);return;
        }
        // Anything else: name the code instead of hiding it. These are short machine
        // codes (SC19_PAYMENT_RETRY, HTTP 503) with nothing private in them, and they
        // are the difference between "retry" and "the payment operator is refusing us".
        const code=typeof data.error==='string'?data.error:`HTTP ${response.status}`;
        const detail=p24Detail(data.detail);
        setMessage(checkoutFailed(detail?`${code} / ${detail}`:code));return;
      }
      setOrderId(data.orderId);
      if (uuid(companyId) && uuid(data.orderId) && uuid(recruitmentId)) try {
        sessionStorage.setItem(contextKey(companyId, data.orderId), recruitmentId.toLowerCase());
      } catch { /* Navigation may fall back to the company panel; checkout still works. */ }
      try {sessionStorage.setItem(`sc19:order:${companyId}`,data.orderId);} catch { /* optional */ }
      if(data.status==='paid'){await status(data.orderId);return;}
      window.location.assign(data.checkoutUrl);
    } catch {setMessage('Nie udało się otworzyć płatności. Ponów próbę — serwer sprawdzi istniejące zamówienie.');}
    finally {setBusy(false);}
  }
  const returnLink = !uuid(recruitmentId) && uuid(companyId) && returnedRecruitment
    ? <p><a href={`/dashboard/${companyId}/recruitments/${returnedRecruitment}`}>Wróć do rekrutacji</a></p> : null;
  if (statusOnly) return <section aria-busy={busy}>
    {returnLink}
    <h2>Status zamówienia testowego</h2>
    <p role="status">{message || 'Sprawdzamy potwierdzenie w Przelewy24…'}</p>
    <button type="button" disabled={!orderId || busy} onClick={()=>status()}>Sprawdź status zamówienia</button>
  </section>;
  return <section aria-busy={loading||busy}>
    {returnLink}
    {sandbox&&<p role="note">{sandboxNotice}</p>}
    <p>Pakiet FREE nie wymaga płatności i nie korzysta z tego formularza.</p>
    {loading ? <p role="status">Wczytuję ofertę…</p> : offers.length>0 ? <>
      <label>Wariant <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setAccepted(false);}}>
        {offers.map(o=><option key={o.id} value={o.id}>{o.credits} analiz CV — {pln(o.amountMinor)} brutto</option>)}
      </select></label>
      {offer&&<><h2>{pln(offer.amountMinor)} brutto</h2><p>{offer.credits} analiz CV • jednorazowo • analizy ważne 3 miesiące od przyznania</p>
        <table><caption>Podsumowanie zamówienia</caption><tbody>
          <tr><th scope="row">Pakiet</th><td>PRESELEKCJA</td></tr>
          <tr><th scope="row">Liczba analiz CV</th><td>{offer.credits}</td></tr>
          {amounts&&<tr><th scope="row">Cena netto</th><td>{pln(amounts.netMinor)}</td></tr>}
          {amounts&&<tr><th scope="row">VAT{typeof amounts.vatBasisPoints==='number'?` ${amounts.vatBasisPoints/100}%`:''}</th><td>{pln(amounts.vatMinor)}</td></tr>}
          <tr><th scope="row">Cena brutto</th><td>{pln(offer.amountMinor)}</td></tr>
        </tbody></table>
        <details open><summary>Warunki oferty · {offer.termsRevision}</summary><p style={{whiteSpace:'pre-wrap'}}>{offer.termsText}</p></details>
        <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={accepted} disabled={busy}
          onChange={e=>setAccepted(e.target.checked)}/> Akceptuję powyższe warunki oferty oraz <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> i potwierdzam zapoznanie się z <a href="/polityka-prywatnosci" target="_blank" rel="noopener">Polityką prywatności</a>.</label>
        <p>Płatność online obsługuje Przelewy24 (PayPro S.A., ul. Pastelowa 8, 60-198 Poznań): szybki przelew, BLIK lub karta, w zakresie metod udostępnionych przez operatora. Analizy przyznajemy niezwłocznie po potwierdzeniu płatności: po zaksięgowaniu wpłaty na naszym rachunku, a przy płatności online — po jej potwierdzeniu przez operatora, zwykle w ciągu kilku minut. Zasady reklamacji i odstąpienia opisuje <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> (§ 10–11).</p>
        {!checkoutAvailable&&<p role="status" aria-live="polite">{paymentsPending}</p>}
        <button type="button" disabled={!checkoutAvailable||!accepted||busy||!!paidOrder} onClick={buy}>
          {busy?'Przetwarzam…':checkoutAvailable?`Zamawiam i płacę ${pln(offer.amountMinor)}`:`Zamawiam i płacę ${pln(offer.amountMinor)} — wkrótce`}</button></>}
    </> : !message&&<p>Brak zatwierdzonej oferty. Zakup jest obecnie niedostępny.</p>}
    {message&&<p role="status" aria-live="polite">{message}</p>}
    <button type="button" disabled={busy||loading} onClick={()=>{setMessage('');return loadOffers();}}>Odśwież oferty</button>
    {paidOrder&&<button type="button" disabled={busy} onClick={nextPurchase}>Kup kolejny pakiet</button>}
    {orderId&&<button type="button" disabled={busy} onClick={()=>status()}>Sprawdź status zamówienia</button>}
    <p>Powrót ze strony operatora nie jest potwierdzeniem zapłaty. Status sprawdzamy na serwerze.</p>
  </section>;
}
