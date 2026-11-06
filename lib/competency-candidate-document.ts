// Isolated HTML document: no Next hydration, analytics, third-party assets or
// persistent browser storage. Only trusted, server-generated nonces enter HTML.
export function candidateDocument(nonce:string) {
  if(!/^[A-Za-z0-9+/]{24}$/.test(nonce)) throw new Error('Invalid nonce');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zadanie kompetencyjne</title>
<script nonce="${nonce}">(() => {
  let grant = location.hash.slice(1);
  history.replaceState(null,'',location.pathname);
  let csrf = '', busy = false, version = 0, deadline = 0;
  const endpoint='/api/competency/attempt';
  const el=id=>document.getElementById(id);
  async function call(operation,fields={}) {
    const headers={'content-type':'application/json'};
    if(operation==='bootstrap') headers['x-sc014-intent']='bootstrap';
    else headers['x-sc014-csrf']=csrf;
    const response=await fetch(endpoint,{method:'POST',headers,credentials:'same-origin',cache:'no-store',
      redirect:'error',referrerPolicy:'no-referrer',body:JSON.stringify({operation,...fields})});
    if(!response.ok) throw new Error(String(response.status));
    return response.json();
  }
  function show(view) {
    for(const id of ['start','work','receipt']) el(id).hidden=true;
    if(view.state==='submitted') {
      el('answer').value='';el('receipt').hidden=false;el('message').textContent='Odpowiedź została przyjęta.';return;
    }
    if(view.state==='not_started') {
      el('start').hidden=false;el('message').textContent='Czas na wykonanie: '+view.durationMinutes+' min. Licznik ruszy po rozpoczęciu.';return;
    }
    if(view.state!=='in_progress') throw new Error('invalid');
    deadline=Date.parse(view.deadlineAt); if(!Number.isFinite(deadline)||deadline<=Date.now()) throw new Error('expired');
    el('title').textContent=view.test.title;el('instructions').textContent=view.test.instructions;
    el('output').textContent=view.test.expectedOutput;el('until').textContent=new Date(deadline).toLocaleString('pl-PL');
    el('answer').value=view.draft.text;version=view.draft.version;el('work').hidden=false;
    el('message').textContent='Wpisz odpowiedź. Możesz zapisać szkic przed wysłaniem.';
  }
  async function run(action) {
    if(busy)return; busy=true; el('controls').disabled=true;
    try {await action();}catch(e) {
      el('message').textContent=e.message==='409'?'Stan zadania zmienił się lub czas minął. Zachowaj swoją odpowiedź i odśwież stronę.':
        'Nie udało się potwierdzić operacji. Zachowaj treść i odśwież stronę, aby sprawdzić stan.';
      // Unknown mutation outcome: never retry automatically; keep a selectable copy of unsent text.
      const answer = el('answer').value;
      if (answer) { el('recovery-text').value = answer; el('recovery').hidden = false; }
      return;
    }finally{busy=false;}
    el('controls').disabled=false;
  }
  document.addEventListener('DOMContentLoaded',()=>{
    el('begin').onclick=()=>run(async()=>show(await call('start',{requestKey:crypto.randomUUID()})));
    el('save').onclick=()=>run(async()=>{
      const result=await call('save',{draft:el('answer').value,expectedVersion:version,requestKey:crypto.randomUUID()});
      version=result.version;el('message').textContent='Szkic zapisany.';
    });
    el('submit').onclick=()=>run(async()=>{
      if(!el('answer').value.trim()){el('message').textContent='Wpisz odpowiedź przed wysłaniem.';return;}
      show(await call('submit',{answer:{workSample:el('answer').value},requestKey:crypto.randomUUID()}));
    });
    run(async()=>{
      try {
        if(grant&&!/^grant=[0-9a-f]{64}$/.test(grant))throw new Error('invalid');
        csrf=(await call('bootstrap')).csrf;
        if(grant) csrf=(await call('exchange',{token:grant.slice(6)})).csrf;
      } finally {grant='';}
      show(await call('inspect'));
    });
  });
})();</script></head><body><main><h1 id="title">Zadanie kompetencyjne</h1>
<p role="status" id="message">Sprawdzamy dostęp do zadania…</p>
<fieldset id="controls" disabled><legend>Twoja próba</legend><section hidden id="start"><button id="begin">Rozpocznij zadanie</button></section>
<section hidden id="work"><h2>Instrukcja</h2><p id="instructions"></p><h3>Oczekiwany rezultat</h3><p id="output"></p>
<p>Termin: <time id="until"></time></p><label>Twoja odpowiedź <textarea maxlength="20000" id="answer" rows="12"></textarea></label>
<button id="save">Zapisz szkic</button><button id="submit">Wyślij odpowiedź ostateczną</button></section>
<p id="receipt" hidden>Możesz zamknąć tę stronę.</p></fieldset>
<section id="recovery" hidden><h2>Kopia odpowiedzi do skopiowania</h2>
<p>Skopiuj poniższy tekst przed odświeżeniem. Nie wysyłaj go ponownie bez sprawdzenia stanu zadania.</p>
<label>Twoja zachowana odpowiedź<textarea id="recovery-text" readonly rows="12"></textarea></label></section>
<noscript>Ta strona wymaga JavaScript.</noscript></main></body></html>`;
}
