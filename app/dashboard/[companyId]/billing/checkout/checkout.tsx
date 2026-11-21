'use client';
import { useEffect, useState } from 'react';
import { sc19OfferAmounts } from '../../../../../lib/sc19-offer-amounts';
import { CV_POOL_STEP, MAX_PACKAGES, STRIPE_CATALOG, isStripePackageCode, packagesForPool, type StripePackageCode } from '../../../../../lib/stripe-catalog';
type Offer={id:string;revision:string;packageCode?:string;amountMinor:number;currency:string;credits:number;
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
const paymentsPending='Płatność online jest w trakcie uruchamiania. Zamówienia nie można jeszcze złożyć — cena i warunki poniżej są wiążące i nie zmienią się po włączeniu płatności.';
/** A failure we have no dedicated sentence for. The code is shown on purpose: it
 * is the only thing that tells support whether to retry or to look at the payment
 * operator, and it contains no private data. */
const checkoutFailed=(code:string)=>
  `Nie udało się otworzyć płatności. Ponów próbę — serwer sprawdzi istniejące zamówienie. Jeśli to się powtarza, napisz na pomoc@skillcheck.pl i podaj kod: ${code}.`;
const reconciliationRequired='Tego zamówienia nie można już otworzyć ani potwierdzić automatycznie. Ponawianie nie pomoże. Napisz na pomoc@skillcheck.pl, podaj nazwę firmy — odblokujemy zamówienie i będziesz mógł złożyć nowe.';
const sessionExpired='Sesja płatności wygasła. Zamówienie zamknęliśmy bez żadnej opłaty i bez przyznania pakietu. Kliknij ponownie, aby rozpocząć nowy zakup.';
// R7: the Stripe hosted page. Methods offered there depend on the Stripe account;
// the list names what the account is set up for, not a promise of each one.
const stripeText='Płatność online obsługuje Stripe (karta, BLIK, Przelewy24, Apple Pay, Google Pay). Na stronie płatności podasz dane firmy do faktury, w tym NIP. Pakiet przyznajemy automatycznie po potwierdzeniu płatności przez Stripe, zwykle w ciągu kilku minut. Zasady reklamacji i odstąpienia opisuje Regulamin (§ 10–11).';
const stripeTestNotice='Płatność testowa Stripe: żadne pieniądze nie zostaną pobrane. Pakiet i analizy CV zostaną jednak przyznane na tym koncie tak samo jak po zwykłym zakupie.';
// R7: what each package adds over the CV analyses (docs/cennik-2026-11-02.md). No voicebot.
const packageExtras:Record<StripePackageCode,string>={PRESELEKCJA:'',
  WERYFIKACJA:'testy kompetencji dla kandydatów z shortlisty i rozszerzony raport',
  ASSESSMENT_CENTER:'testy kompetencji, zadania praktyczne i sesja Assessment Center dla finalistów (5–6 osób)'};
/** Packages not offered right now (not on sale, or no migration yet): shown as „wkrótce”. */
const soonPackages=(offers:Offer[])=>[STRIPE_CATALOG.WERYFIKACJA,STRIPE_CATALOG.ASSESSMENT_CENTER]
  .filter(p=>!offers.some(o=>offerPackage(o)===p.code));
const offerPackage=(o:{packageCode?:unknown}|undefined):StripePackageCode=>o&&isStripePackageCode(o.packageCode)?o.packageCode:'PRESELEKCJA';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const contextKey = (companyId: string, orderId: string) => `sc19:recruitment:${companyId.toLowerCase()}:${orderId.toLowerCase()}`;
// R7: Stripe is the only payment provider (owner decision 19.11.2026); the return
// from the Stripe hosted page carries the order id in `?stripe=<uuid>`.
const returnParam='stripe';
const cvCountInvalid='Wybrana pula CV nie jest dozwolona. Wybierz pulę CV ponownie.';
/** R5 W2b: the server's Polish sentence for a refused CV count (fixed wording and
 * numbers only). Rendered as text, never as HTML; anything else falls back. */
const cvCountMessage=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=300?value:cvCountInvalid;
export default function Checkout({companyId,recruitmentId,statusOnly=false,testMode=false,cvPoolEnabled=false}: {companyId:string;recruitmentId?:string;statusOnly?:boolean;testMode?:boolean;
  /** R5 W2b: PRICING_CV_SLIDER_ENABLED. On: the PRESELEKCJA order also sends the
   * chosen CV pool (`cvCount`) and the server checks it. Off: request unchanged. */
  cvPoolEnabled?:boolean}) {
  // PRESELEKCJA is sold in whole packages of 60 CV; the slider picks a pool (co 5)
  // and the server recomputes the amount from the package count.
  const [pool,setPool]=useState(STRIPE_CATALOG.PRESELEKCJA.cvCredits);
  const [offers,setOffers]=useState<Offer[]>([]),[selected,setSelected]=useState('');
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [checkoutAvailable,setCheckoutAvailable]=useState(true);
  const [orderId,setOrderId]=useState(''),[paidOrder,setPaidOrder]=useState<{offerId:string;termsRevision:string;packages:number|null}|null>(null);
  const [requestIds]=useState(()=>new Map<string,string>());
  const [returnedRecruitment,setReturnedRecruitment]=useState<string|null>(null);
  const selectedOffer=offers.find(o=>o.id===selected);
  const code=offerPackage(selectedOffer);
  // PRESELEKCJA: whole packages from the pool; WERYFIKACJA and ASSESSMENT CENTER: one package.
  const packages=code==='PRESELEKCJA'?packagesForPool(pool):1;
  const offer=selectedOffer&&packages?{...selectedOffer,amountMinor:selectedOffer.amountMinor*packages,credits:selectedOffer.credits*packages,
    netMinor:null,vatMinor:null}:selectedOffer;
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
    const returned = new URLSearchParams(window.location.search).get(returnParam);
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
  },[companyId,statusOnly]);
  async function status(id=orderId) {
    if(!id)return;
    setBusy(true);
    try {
      const r=await fetch(`/api/billing/orders/${encodeURIComponent(id)}?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store'});
      if(!r.ok)throw Error(); const data=await r.json();
      // The paid order's own package count (its CV pool / 60), not the form's current
      // value: the request key of THAT purchase is the one to clear.
      const paidCode=offerPackage(data);
      const paidPackages=Number.isSafeInteger(data.credits/STRIPE_CATALOG[paidCode].cvCredits)
        ?data.credits/STRIPE_CATALOG[paidCode].cvCredits:null;
      setPaidOrder(data.status==='paid'?{offerId:data.offerId,termsRevision:data.termsRevision,packages:paidPackages}:null);
      setMessage(data.status==='expired' ? sessionExpired : data.status==='paid' ? (paidCode==='PRESELEKCJA' ? `Płatność potwierdzona. Przyznano ${data.credits} analiz CV.`
        : `Płatność potwierdzona. Przyznano pakiet ${STRIPE_CATALOG[paidCode].name} i ${data.credits} analiz CV.`) :
        'Czekamy na potwierdzenie płatności. Kredyty zostaną przyznane po jej weryfikacji.');
    } catch {setMessage('Nie udało się sprawdzić statusu. Spróbuj ponownie.');}
    finally {setBusy(false);}
  }
  function nextPurchase() {
    if(!paidOrder)return;
    const key=`sc19:request:${companyId}:${paidOrder.offerId}:${paidOrder.termsRevision}:${paidOrder.packages}`;
    requestIds.delete(key);
    try {
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`sc19:order:${companyId}`);
    } catch { /* Server-side order invariant does not depend on browser storage. */ }
    const url = new URL(window.location.href);
    url.searchParams.delete(returnParam);
    url.searchParams.delete('cancelled');
    window.history.replaceState(window.history.state,'',url);
    setOrderId('');setPaidOrder(null);setAccepted(false);setMessage('Możesz złożyć kolejne zamówienie.');
  }
  async function buy() {
    // Never post while checkout is unavailable: the server refuses it anyway
    // (SC19_PAYMENTS_DISABLED), and the button is rendered disabled.
    if(!offer||!accepted||busy||loading||paidOrder||!checkoutAvailable||!packages)return;
    setBusy(true);setMessage('');
    try {
      // Best-effort retry hint. The durable server invariant also protects new
      // tabs/devices and browsers where sessionStorage is missing or evicted.
      const key=`sc19:request:${companyId}:${offer.id}:${offer.termsRevision}:${packages}`;
      let requestId=requestIds.get(key);
      try {requestId ??= sessionStorage.getItem(key) ?? undefined;} catch { /* optional */ }
      requestId ??= crypto.randomUUID();requestIds.set(key,requestId);
      try {sessionStorage.setItem(key,requestId);} catch { /* optional */ }
      // R5 W2b: with the slider flag on, the PRESELEKCJA pool goes with the order.
      // The server derives the packages from it and refuses a mismatch; it never
      // sets the price. Other packages have no slider, so nothing extra is sent.
      const cvCount=cvPoolEnabled&&code==='PRESELEKCJA'?{cvCount:pool}:{};
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({companyId,offerId:offer.id,termsRevision:offer.termsRevision,requestId,packages,packageCode:code,...cvCount})});
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
        if(cvPoolEnabled&&data.error==='SC19_PAYMENT_CV_COUNT_INVALID'){
          setAccepted(false);setMessage(cvCountMessage(data.message));return;
        }
        // The order exists but its payment session can no longer be opened or
        // confirmed automatically. Retrying cannot help and the next purchase stays
        // blocked until we clear this one, so say that instead of "try again".
        if(data.error==='SC19_PAYMENT_RECONCILIATION_REQUIRED'){
          setMessage(reconciliationRequired);return;
        }
        // R7: the payment session expired unpaid and the order was closed without any
        // charge or grant. Its request id is spent; the next click is a new purchase.
        if(data.error==='SC19_PAYMENT_SESSION_EXPIRED'){
          requestIds.delete(key);
          try {sessionStorage.removeItem(key);sessionStorage.removeItem(`sc19:order:${companyId}`);} catch { /* optional */ }
          setOrderId('');
          setMessage(sessionExpired);return;
        }
        // Anything else: name the code instead of hiding it. These are short machine
        // codes (SC19_PAYMENT_RETRY, HTTP 503) with nothing private in them, and they
        // are the difference between "retry" and "the payment operator is refusing us".
        const code=typeof data.error==='string'?data.error:`HTTP ${response.status}`;
        setMessage(checkoutFailed(code));return;
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
    <p role="status">{message || 'Sprawdzamy potwierdzenie płatności…'}</p>
    <button type="button" disabled={!orderId || busy} onClick={()=>status()}>Sprawdź status zamówienia</button>
  </section>;
  return <section aria-busy={loading||busy}>
    {returnLink}
    {testMode&&<p role="note">{stripeTestNotice}</p>}
    <p>Pakiet FREE nie wymaga płatności i nie korzysta z tego formularza.</p>
    {loading ? <p role="status">Wczytuję ofertę…</p> : offers.length>0 ? <>
      <label>Wariant <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setAccepted(false);}}>
        {offers.map(o=><option key={o.id} value={o.id}>{`${STRIPE_CATALOG[offerPackage(o)].name}: `}{o.credits} analiz CV — {pln(o.amountMinor)} brutto</option>)}
      </select></label>
      {selectedOffer&&code==='PRESELEKCJA'&&<label>Pula CV (co {CV_POOL_STEP}) <input type="number" min={CV_POOL_STEP} step={CV_POOL_STEP}
        max={MAX_PACKAGES*STRIPE_CATALOG.PRESELEKCJA.cvCredits} value={pool} disabled={busy}
        onChange={e=>{setPool(Number(e.target.value));setAccepted(false);}}/>
        <small>{packages ? `PRESELEKCJA sprzedajemy w całych pakietach po ${STRIPE_CATALOG.PRESELEKCJA.cvCredits} CV: ${packages} ${packages===1?'pakiet':'pakiety'} = ${packages*STRIPE_CATALOG.PRESELEKCJA.cvCredits} analiz CV.`
          : `Podaj wielokrotność ${CV_POOL_STEP}, od ${CV_POOL_STEP} do ${MAX_PACKAGES*STRIPE_CATALOG.PRESELEKCJA.cvCredits} CV.`}</small></label>}
      {offer&&<><h2>{pln(offer.amountMinor)} brutto</h2><p>{offer.credits} analiz CV{packageExtras[code]?` • ${packageExtras[code]}`:''} • jednorazowo • analizy ważne 3 miesiące od przyznania</p>
        <table><caption>Podsumowanie zamówienia</caption><tbody>
          <tr><th scope="row">Pakiet</th><td>{STRIPE_CATALOG[code].name}</td></tr>
          {packageExtras[code]&&<tr><th scope="row">W pakiecie</th><td>{packageExtras[code]}</td></tr>}
          <tr><th scope="row">Liczba analiz CV</th><td>{offer.credits}</td></tr>
          {amounts&&<tr><th scope="row">Cena netto</th><td>{pln(amounts.netMinor)}</td></tr>}
          {amounts&&<tr><th scope="row">VAT{typeof amounts.vatBasisPoints==='number'?` ${amounts.vatBasisPoints/100}%`:''}</th><td>{pln(amounts.vatMinor)}</td></tr>}
          <tr><th scope="row">Cena brutto</th><td>{pln(offer.amountMinor)}</td></tr>
        </tbody></table>
        <details open><summary>Warunki oferty · {offer.termsRevision}</summary><p style={{whiteSpace:'pre-wrap'}}>{offer.termsText}</p></details>
        <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={accepted} disabled={busy}
          onChange={e=>setAccepted(e.target.checked)}/> Akceptuję powyższe warunki oferty oraz <a href="/regulamin" target="_blank" rel="noopener">Regulamin</a> i potwierdzam zapoznanie się z <a href="/polityka-prywatnosci" target="_blank" rel="noopener">Polityką prywatności</a>.</label>
        <p>{stripeText}</p>
        {!checkoutAvailable&&<p role="status" aria-live="polite">{paymentsPending}</p>}
        <button type="button" disabled={!checkoutAvailable||!accepted||busy||!!paidOrder||!packages} onClick={buy}>
          {busy?'Przetwarzam…':checkoutAvailable?`Zamawiam i płacę ${pln(offer.amountMinor)}`:`Zamawiam i płacę ${pln(offer.amountMinor)} — wkrótce`}</button></>}
    </> : !message&&<p>Brak zatwierdzonej oferty. Zakup jest obecnie niedostępny.</p>}
    {soonPackages(offers).length>0&&<><h2>Wkrótce</h2><ul>{soonPackages(offers).map(p=><li key={p.code}>{p.name} — {pln(p.grossMinor)} brutto za {p.cvCredits} CV — wkrótce</li>)}</ul></>}
    {message&&<p role="status" aria-live="polite">{message}</p>}
    <button type="button" disabled={busy||loading} onClick={()=>{setMessage('');return loadOffers();}}>Odśwież oferty</button>
    {paidOrder&&<button type="button" disabled={busy} onClick={nextPurchase}>Kup kolejny pakiet</button>}
    {orderId&&<button type="button" disabled={busy} onClick={()=>status()}>Sprawdź status zamówienia</button>}
    <p>Powrót ze strony operatora nie jest potwierdzeniem zapłaty. Status sprawdzamy na serwerze.</p>
  </section>;
}
