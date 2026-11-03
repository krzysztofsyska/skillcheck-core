'use client';
import { useEffect, useState } from 'react';
import { preselekcjaOffer } from '../../../../../lib/preselekcja-offer';
type Offer={id:string;revision:string;amountMinor:number;currency:string;credits:number;
  termsRevision:string;termsText:string;validUntilMs:number};
const pln=(v:number)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(v/100);
// Przelewy24 is wired up in a separate task. Until then the checkout screen may
// point at a hosted payment page configured by the owner; an empty or non-http
// value keeps the button disabled instead of linking somewhere unexpected.
const p24CheckoutUrl=(companyId:string)=>{
  const raw=(typeof process==='undefined'?'':process.env.NEXT_PUBLIC_P24_CHECKOUT_URL ?? '').trim();
  if(!raw)return '';
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:')return '';
    // No server-side order exists in this mode, so the payment must carry the
    // company reference the operator reconciles it against before granting credits.
    url.searchParams.set('ref',companyId);
    return url.toString();
  }catch{return '';}
};
export default function Checkout({companyId,fallbackCredits}: {companyId:string;fallbackCredits:number|null}) {
  const [offers,setOffers]=useState<Offer[]>([]),[selected,setSelected]=useState('');
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [orderId,setOrderId]=useState(''),[paidOrder,setPaidOrder]=useState<{offerId:string;termsRevision:string}|null>(null);
  const [requestIds]=useState(()=>new Map<string,string>());
  // Offers API unavailable: show the approved package summary instead of a dead end.
  const [fallback,setFallback]=useState(false),[fallbackAccepted,setFallbackAccepted]=useState(false);
  const offer=offers.find(o=>o.id===selected);
  const payUrl=p24CheckoutUrl(companyId);
  async function loadOffers(signal?: AbortSignal) {
    setLoading(true);setAccepted(false);setOffers([]);setSelected('');setFallback(false);
    try {
      const r=await fetch(`/api/billing/offers?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store',signal});
      if(!r.ok)throw Error();const data=await r.json();
      if(!signal?.aborted){setOffers(data.offers);setSelected(data.offers[0]?.id ?? '');}
    } catch {
      if(!signal?.aborted){setFallback(true);setMessage('');}
    } finally {if(!signal?.aborted)setLoading(false);}
  }
  useEffect(()=>{
    const abort=new AbortController();
    void loadOffers(abort.signal);
    try { setOrderId(sessionStorage.getItem(`sc19:order:${companyId}`) ?? ''); } catch { /* unavailable storage: status can be retried in this session */ }
    return ()=>abort.abort();
  },[companyId]);
  async function status(id=orderId) {
    if(!id)return;
    setBusy(true);
    try {
      const r=await fetch(`/api/billing/orders/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store'});
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
    setOrderId('');setPaidOrder(null);setAccepted(false);setMessage('Możesz złożyć kolejne zamówienie.');
  }
  async function buy() {
    if(!offer||!accepted||busy||loading||paidOrder)return;
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
      const data=await response.json();
      if(!response.ok){
        if(data.error==='SC19_PAYMENT_OFFER_UNAVAILABLE'){
          setMessage('Oferta wygasła lub zmieniły się jej warunki. Odświeżamy dostępne oferty. Sprawdź je i zaakceptuj ponownie.');
          await loadOffers();return;
        }
        if(data.error==='SC19_PAYMENT_PURCHASE_PENDING'){
          setMessage('Firma ma już nierozliczone zamówienie z innymi warunkami. Dokończ je lub skontaktuj się z obsługą przed kolejnym zakupem.');return;
        }
        throw Error();
      }
      setOrderId(data.orderId);
      try {sessionStorage.setItem(`sc19:order:${companyId}`,data.orderId);} catch { /* optional */ }
      if(data.status==='paid'){await status(data.orderId);return;}
      window.location.assign(data.checkoutUrl);
    } catch {setMessage('Nie udało się otworzyć płatności. Ponów próbę — serwer sprawdzi istniejące zamówienie.');}
    finally {setBusy(false);}
  }
  return <section aria-busy={loading||busy}>
    <p>Pakiet FREE nie wymaga płatności i nie korzysta z tego formularza.</p>
    {loading ? <p role="status">Wczytuję ofertę…</p> : offers.length>0 ? <>
      <label>Wariant <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setAccepted(false);}}>
        {offers.map(o=><option key={o.id} value={o.id}>{o.credits} analiz CV — {pln(o.amountMinor)} brutto</option>)}
      </select></label>
      {offer&&<><h2>{pln(offer.amountMinor)} brutto</h2><p>{offer.credits} analiz CV • jednorazowo • analizy ważne 3 miesiące od przyznania</p>
        <details open><summary>Warunki oferty · {offer.termsRevision}</summary><p style={{whiteSpace:'pre-wrap'}}>{offer.termsText}</p></details>
        <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={accepted} disabled={busy}
          onChange={e=>setAccepted(e.target.checked)}/> Akceptuję powyższe warunki oferty oraz <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> i potwierdzam zapoznanie się z <a href="/polityka-prywatnosci" target="_blank" rel="noopener">Polityką prywatności</a>.</label>
        <p>Płatność online obsługuje Przelewy24 (PayPro S.A., ul. Pastelowa 8, 60-198 Poznań): szybki przelew, BLIK lub karta, w zakresie metod udostępnionych przez operatora. Analizy przyznajemy po potwierdzeniu płatności przez operatora, zwykle w ciągu kilku minut. Zasady reklamacji i odstąpienia opisuje <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> (§ 10–11).</p>
        <button type="button" disabled={!accepted||busy||!!paidOrder} onClick={buy}>
          {busy?'Przetwarzam…':`Zamawiam i płacę ${pln(offer.amountMinor)}`}</button></>}
    </> : fallback ? <section aria-label="Podsumowanie pakietu PRESELEKCJA">
      <h2>{preselekcjaOffer.grossPln} zł brutto</h2>
      {fallbackCredits===null
        ? <p>Liczba analiz CV zgodna z zatwierdzoną polityką pakietów • jednorazowo • {preselekcjaOffer.netPln} zł netto + 23% VAT</p>
        : <p>{fallbackCredits} analiz CV • jednorazowo • {preselekcjaOffer.netPln} zł netto + 23% VAT</p>}
      <p>Analizy ważne {preselekcjaOffer.validityMonths} miesiące od dnia przyznania. Wyniki weryfikuje rekruter; SkillCheck nie podejmuje decyzji o zatrudnieniu.</p>
      <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={fallbackAccepted}
        onChange={e=>setFallbackAccepted(e.target.checked)}/> Akceptuję <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> i potwierdzam zapoznanie się z <a href="/polityka-prywatnosci" target="_blank" rel="noopener">Polityką prywatności</a>.</label>
      {fallbackCredits!==null&&payUrl
        ? <a className="button" href={fallbackAccepted?payUrl:undefined} aria-disabled={!fallbackAccepted}
            rel="noopener" onClick={e=>{if(!fallbackAccepted)e.preventDefault();}}>Przejdź do płatności</a>
        : <><button type="button" disabled>Przejdź do płatności</button>
          <p role="status">{fallbackCredits===null
            ? 'Zakup chwilowo niedostępny — zatwierdzona liczba analiz jest nieosiągalna.'
            : 'Płatność Przelewy24 — konfiguracja w toku'}</p></>}
      <p>W tym trybie zamówienie nie powstaje automatycznie: analizy przyznaje operator po potwierdzeniu wpłaty. Podaj przy płatności numer referencyjny firmy <strong>{companyId}</strong>. Zasady reklamacji i odstąpienia opisuje <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> (§ 10–11).</p>
    </section> : !message&&<p>Brak zatwierdzonej oferty. Zakup jest obecnie niedostępny.</p>}
    {message&&<p role="status" aria-live="polite">{message}</p>}
    <button type="button" disabled={busy||loading} onClick={()=>{setMessage('');return loadOffers();}}>Odśwież oferty</button>
    {paidOrder&&<button type="button" disabled={busy} onClick={nextPurchase}>Kup kolejny pakiet</button>}
    {orderId&&<button type="button" disabled={busy} onClick={()=>status()}>Sprawdź status zamówienia</button>}
    <p>Powrót ze strony operatora nie jest potwierdzeniem zapłaty. Status sprawdzamy na serwerze.</p>
  </section>;
}
