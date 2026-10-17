'use client';
import { useEffect, useState } from 'react';
type Offer={id:string;revision:string;amountMinor:number;currency:string;credits:number;
  termsRevision:string;termsText:string;validUntilMs:number};
const pln=(v:number)=>new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(v/100);
export default function Checkout({companyId}: {companyId:string}) {
  const [offers,setOffers]=useState<Offer[]>([]),[selected,setSelected]=useState('');
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true),[message,setMessage]=useState('');
  const [orderId,setOrderId]=useState(''),[paidOrder,setPaidOrder]=useState<{offerId:string;termsRevision:string}|null>(null);
  const offer=offers.find(o=>o.id===selected);
  useEffect(()=>{
    const abort=new AbortController();
    fetch(`/api/billing/offers?companyId=${encodeURIComponent(companyId)}`,{cache:'no-store',signal:abort.signal})
      .then(async r=>{if(!r.ok)throw Error();return r.json();})
      .then(data=>{setOffers(data.offers);setSelected(data.offers[0]?.id ?? '');})
      .catch(()=>{if(!abort.signal.aborted)setMessage('Płatności nie są jeszcze dostępne. Cena i warunki oferty oczekują na zatwierdzenie.');})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
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
    try {
      sessionStorage.removeItem(`sc19:request:${companyId}:${paidOrder.offerId}:${paidOrder.termsRevision}`);
      sessionStorage.removeItem(`sc19:order:${companyId}`);
      setOrderId('');setPaidOrder(null);setAccepted(false);setMessage('Możesz złożyć kolejne zamówienie.');
    } catch {setMessage('Przeglądarka blokuje zapis nowego zamówienia. Zezwól na pamięć sesji.');}
  }
  async function buy() {
    if(!offer||!accepted||busy||paidOrder)return;
    setBusy(true);setMessage('');
    try {
      // A lost HTTP response / reload must reuse the same durable request ID.
      // Refuse checkout if persistence is unavailable; do not silently generate a new key.
      const key=`sc19:request:${companyId}:${offer.id}:${offer.termsRevision}`;
      let requestId=sessionStorage.getItem(key);
      if(!requestId){requestId=crypto.randomUUID();sessionStorage.setItem(key,requestId);}
      const response=await fetch('/api/billing/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({companyId,offerId:offer.id,termsRevision:offer.termsRevision,requestId})});
      if(!response.ok)throw Error(); const data=await response.json();
      setOrderId(data.orderId);sessionStorage.setItem(`sc19:order:${companyId}`,data.orderId);
      if(data.status==='paid'){await status(data.orderId);return;}
      window.location.assign(data.checkoutUrl);
    } catch {setMessage('Nie udało się otworzyć płatności. Ponowienie użyje tego samego zamówienia. Jeśli przeglądarka blokuje pamięć sesji, zezwól na nią.');}
    finally {setBusy(false);}
  }
  return <section aria-busy={loading||busy}>
    <p>Pakiet FREE nie wymaga płatności i nie korzysta z tego formularza.</p>
    {loading ? <p role="status">Wczytuję ofertę…</p> : offers.length>0 ? <>
      <label>Wariant <select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setAccepted(false);}}>
        {offers.map(o=><option key={o.id} value={o.id}>{o.credits} analiz CV — {pln(o.amountMinor)} brutto</option>)}
      </select></label>
      {offer&&<><h2>{pln(offer.amountMinor)} brutto</h2><p>{offer.credits} analiz CV • jednorazowo</p>
        <details open><summary>Warunki oferty · {offer.termsRevision}</summary><p style={{whiteSpace:'pre-wrap'}}>{offer.termsText}</p></details>
        <label style={{display:'block',margin:'20px 0'}}><input type="checkbox" checked={accepted} disabled={busy}
          onChange={e=>setAccepted(e.target.checked)}/> Akceptuję powyższe warunki oferty.</label>
        <button type="button" disabled={!accepted||busy||!!paidOrder||offer.validUntilMs<=Date.now()} onClick={buy}>
          {busy?'Przetwarzam…':`Zamawiam i płacę ${pln(offer.amountMinor)}`}</button></>}
    </> : !message&&<p>Brak zatwierdzonej oferty. Zakup jest obecnie niedostępny.</p>}
    {message&&<p role="status" aria-live="polite">{message}</p>}
    {paidOrder&&<button type="button" disabled={busy} onClick={nextPurchase}>Kup kolejny pakiet</button>}
    {orderId&&<button type="button" disabled={busy} onClick={()=>status()}>Sprawdź status zamówienia</button>}
    <p>Powrót ze strony operatora nie jest potwierdzeniem zapłaty. Status sprawdzamy na serwerze.</p>
  </section>;
}
