'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  InterviewQuestion, InterviewQuestionNote, InterviewNoteRevision,
  AssessmentStage, ApplicationStageTransition, HumanCandidateDecision
} from '../../../../../../../../lib/supabase/database.types';
import { decisionLabels } from '../../../../../../../../lib/interview-workflow';
import styles from './interview.module.css';

type Route = { companyId: string; recruitmentId: string; applicationId: string };
type Gap = { itemId: string; requirementKey: string; requirementText: string; questionText: string; index: number };
type Payload = Record<string,unknown>;

async function write(route: Route, payload: Payload) {
  const response = await fetch('/api/interview-workflow', {
    method:'POST',headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...route,...payload }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Nie udało się zapisać.');
  return data;
}
const stamp = (value: string) => new Date(value).toLocaleString('pl-PL',{timeZone:'Europe/Warsaw'});

function NoteEditor({route,questionId,note,history,canEdit}:{
  route:Route;questionId:string;note?:InterviewQuestionNote;history:InterviewNoteRevision[];canEdit:boolean
}) {
  const initial = { answer:note?.answer_text||'', observation:note?.observation_text||'' };
  const router=useRouter();
  const [draft,setDraft] = useState(initial);
  const latest = useRef(initial);
  const saved = useRef(initial);
  const version = useRef(note?.version??0);
  const inFlight = useRef(false);
  const blocked = useRef(false);
  const [status,setStatus] = useState('');
  const [meta,setMeta] = useState(note ? `${note.updated_by} · ${stamp(note.updated_at)}` : 'Bez zapisu');

  const flush = useCallback(async () => {
    if (inFlight.current || blocked.current || !canEdit) return;
    const current = latest.current;
    if (current.answer === saved.current.answer && current.observation === saved.current.observation) return;
    inFlight.current = true;
    setStatus('Zapisywanie…');
    try {
      const result = await write(route,{
        action:'note',questionId,version:version.current,
        answerText:current.answer,observationText:current.observation,
      });
      version.current = result.version;
      saved.current = current;
      setMeta(`${result.updated_by} · ${stamp(result.updated_at)}`);
      setStatus('Zapisano automatycznie');
      // Refresh audit history; the draft is retained by this component.
      // If typing continued while saving, the next flush uses the new CAS version.
      router.refresh();
    } catch (error) {
      blocked.current = true;
      setStatus(error instanceof Error ? error.message : 'Błąd zapisu.');
    } finally {
      inFlight.current = false;
      if (!blocked.current && (latest.current.answer !== saved.current.answer || latest.current.observation !== saved.current.observation)) {
        setTimeout(() => { void flush(); }, 0);
      }
    }
  }, [route,questionId,canEdit,router]);

  useEffect(() => {
    latest.current = draft;
    if (!canEdit || blocked.current) return;
    if (draft.answer === saved.current.answer && draft.observation === saved.current.observation) return;
    const timer = setTimeout(() => { void flush(); },950);
    return () => clearTimeout(timer);
  },[draft,canEdit,flush]);

  return <div>
    <p className={styles.printOnly}><strong>Odpowiedź:</strong> {draft.answer || '—'}</p>
    <p className={styles.printOnly}><strong>Obserwacja:</strong> {draft.observation || '—'}</p>
    <label className={styles.noPrint}>Odpowiedź kandydata
      <textarea aria-label="Odpowiedź kandydata" rows={4} maxLength={12000}
        readOnly={!canEdit} value={draft.answer}
        onChange={e=>setDraft({...draft,answer:e.target.value})}/>
    </label>
    <label className={styles.noPrint}>Obserwacja rekrutera
      <textarea aria-label="Obserwacja rekrutera" rows={4} maxLength={12000}
        readOnly={!canEdit} value={draft.observation}
        onChange={e=>setDraft({...draft,observation:e.target.value})}/>
    </label>
    <p className={styles.metadata} role="status">Autor i aktualizacja: {meta}. {status}</p>
    {blocked.current && <button type="button" className={styles.noPrint} onClick={()=>{
      blocked.current=false; void flush();
    }}>Ponów zapis (po sprawdzeniu konfliktu)</button>}
    {history.length>0 && <details className={styles.history}>
      <summary>Historia zapisów odpowiedzi i obserwacji ({history.length})</summary>
      <ol>{history.map(h=><li key={h.id}>
        <strong>Wersja {h.version}</strong> · {h.changed_by} · {stamp(h.changed_at)}
        <p>Odpowiedź: {h.answer_text||'—'}</p>
        <p>Obserwacja: {h.observation_text||'—'}</p>
      </li>)}</ol>
    </details>}
  </div>;
}

function QuestionEditor({route,question,canEdit,note,history,first,last}: {
 route:Route;question:InterviewQuestion;canEdit:boolean;note?:InterviewQuestionNote;
 history:InterviewNoteRevision[];first:boolean;last:boolean;
}) {
  const router=useRouter();
  const [text,setText]=useState(question.question_text);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function modify(payload:Payload) {
    setBusy(true);setError('');
    try { await write(route,{...payload,questionId:question.id,version:question.version,analysisId:question.analysis_id});router.refresh(); }
    catch(e){setError(e instanceof Error?e.message:'Błąd zapisu.');}
    finally {setBusy(false);}
  }
  return <article className={styles.question}>
    <p className={styles.metadata}><strong>Wymaganie:</strong> {question.requirement_text}</p>
    <p className={styles.metadata}><strong>Dowód z kroku 3:</strong> {question.evidence_context}</p>
    <p className={styles.metadata}>Źródło: {question.origin==='generated'?'Wiersz zatwierdzony przez człowieka':'Pytanie własne rekrutera'} · {question.requirement_key}</p>
    <h3 className={styles.printOnly}>{text}</h3>
    {canEdit ? <label className={styles.noPrint}>Pytanie
      <textarea rows={3} value={text} maxLength={2000} onChange={e=>setText(e.target.value)}/>
    </label> : <h3>{question.question_text}</h3>}
    {canEdit && <div className={styles.controls}>
      <button type="button" disabled={busy||!text.trim()} onClick={()=>modify({action:'question',questionText:text,isActive:true})}>Zapisz pytanie</button>
      <button type="button" disabled={busy||first} onClick={()=>modify({action:'move',direction:'up'})}>↑ Wyżej</button>
      <button type="button" disabled={busy||last} onClick={()=>modify({action:'move',direction:'down'})}>↓ Niżej</button>
      <button type="button" disabled={busy} onClick={()=>modify({action:'question',questionText:text,isActive:false})}>Usuń z przewodnika</button>
    </div>}
    {error&&<p role="alert">{error}</p>}
    <NoteEditor route={route} questionId={question.id} note={note} history={history} canEdit={canEdit}/>
  </article>;
}

export function InterviewWorkbench({route,analysisId,gaps,questions,notes,noteHistory,canEdit,
  stages,stageHistory,decisions}: {
  route:Route;analysisId:string|null;gaps:Gap[];questions:InterviewQuestion[];
  notes:InterviewQuestionNote[];noteHistory:InterviewNoteRevision[];
  canEdit:boolean;stages:AssessmentStage[];stageHistory:ApplicationStageTransition[];
  decisions:HumanCandidateDecision[];
}) {
  const router=useRouter();
  const [pending,setPending]=useState('');
  const [error,setError]=useState('');
  const [own,setOwn]=useState('');
  const [ownSource,setOwnSource]=useState('');
  const [nextStage,setNextStage]=useState('');
  const [stageReason,setStageReason]=useState('');
  const [decision,setDecision]=useState('');
  const [justification,setJustification]=useState('');

  async function act(name:string,payload:Payload) {
    setPending(name);setError('');
    try {
      await write(route,payload);
      if(name==='add') setOwn('');
      if(name==='stage'){setNextStage('');setStageReason('');}
      if(name==='decision'){setDecision('');setJustification('');}
      router.refresh();
    } catch(e) {setError(e instanceof Error?e.message:'Nie udało się zapisać.');}
    finally {setPending('');}
  }
  const currentStage=stageHistory[0];
  const active=questions.filter(q=>q.is_active).sort((a,b)=>a.sort_order-b.sort_order||a.id.localeCompare(b.id));
  return <div>
    <h2>Przewodnik na podstawie kroku 3</h2>
    <p>Tylko zweryfikowane przez człowieka luki: częściowe, brakujące lub sprzeczne informacje. Zestaw pytań jest edytowalny; niczego nie rozstrzyga automatycznie.</p>
    {canEdit&&analysisId&& <div className={styles.noPrint}>
      <button type="button" disabled={!!pending||!gaps.length}
        onClick={()=>act('seed',{action:'seed',analysisId})}>Utwórz / uzupełnij pytania z zatwierdzonych luk</button>
    </div>}
    {!analysisId && <p>Brak ukończonego zestawienia dowodów. Wykonaj i sprawdź krok 3.</p>}
    {analysisId&&gaps.length===0&&<p>Brak zaakceptowanych lub poprawionych luk do rozmowy.</p>}
    {canEdit&&analysisId&&gaps.length>0&&<div className={styles.noPrint}>
      <h3>Dodaj własne pytanie</h3>
      <label>Powiąż z wymaganiem i dowodem
        <select value={ownSource} onChange={e=>setOwnSource(e.target.value)}>
          <option value="">Wybierz wiersz dowodowy</option>
          {gaps.map(g=><option value={g.itemId} key={g.itemId}>{g.requirementText}</option>)}
        </select>
      </label>
      <label>Treść pytania <textarea value={own} maxLength={2000} onChange={e=>setOwn(e.target.value)}/></label>
      <button type="button" disabled={!own.trim()||!ownSource||!!pending}
        onClick={()=>act('add',{action:'add',analysisId,evidenceItemId:ownSource,questionText:own})}>Dodaj pytanie</button>
    </div>}
    <div className={styles.noPrint}><button type="button" onClick={()=>window.print()}>Drukuj / zapisz jako PDF</button></div>
    <p className={styles.printOnly}>Przewodnik rozmowy — pytania zweryfikowane przez rekrutera.</p>
    {active.length===0&&<p>Nie przygotowano jeszcze pytań do rozmowy.</p>}
    {active.map((question,index)=><QuestionEditor key={question.id+':'+question.version}
      route={route} question={question} canEdit={canEdit}
      note={notes.find(n=>n.question_id===question.id)}
      history={noteHistory.filter(h=>notes.some(n=>n.id===h.note_id&&n.question_id===question.id))}
      first={index===0} last={index===active.length-1}/>)}
    {questions.some(q=>!q.is_active)&&<details className={styles.noPrint}><summary>Usunięte z przewodnika ({questions.filter(q=>!q.is_active).length})</summary>
      {questions.filter(q=>!q.is_active).map(q=><p key={q.id}>{q.question_text}
        {canEdit&&<button type="button" onClick={()=>act('restore',{action:'question',questionId:q.id,version:q.version,questionText:q.question_text,isActive:true})}>Przywróć</button>}
      </p>)}
    </details>}

    <h2>Ręczne etapy rekrutacji</h2>
    <p>Lista etapów jest konfigurowana w rekrutacji przypisanej do stanowiska. Zmiana etapu wymaga działania rekrutera i zostaje zapisana w historii.</p>
    <p><strong>Aktualny etap:</strong> {stages.find(s=>s.id===currentStage?.stage_id)?.name||'Nieustawiony'}</p>
    {canEdit&&<div className={styles.noPrint}>
      <label>Przenieś do etapu
        <select value={nextStage} onChange={e=>setNextStage(e.target.value)}>
          <option value="">Wybierz etap</option>{stages.filter(s=>s.id!==currentStage?.stage_id).map(s=><option key={s.id} value={s.id}>{s.sequence}. {s.name}</option>)}
        </select>
      </label>
      <label>Notatka (opcjonalnie)<textarea value={stageReason} maxLength={2000} onChange={e=>setStageReason(e.target.value)}/></label>
      <button type="button" disabled={!nextStage||!!pending}
        onClick={()=>act('stage',{action:'stage',stageId:nextStage,previousEventId:currentStage?.id??null,reason:stageReason})}>Zapisz przesunięcie</button>
    </div>}
    <details className={styles.history}><summary>Historia zmian etapów ({stageHistory.length})</summary>
      <ol>{stageHistory.map(e=><li key={e.id}>{stamp(e.created_at)} · {e.changed_by}: {stages.find(s=>s.id===e.previous_stage_id)?.name||'Brak'} → {stages.find(s=>s.id===e.stage_id)?.name||'Etap nieznany'}. {e.reason}</li>)}</ol>
    </details>

    <h2>Decyzja człowieka</h2>
    <p className={styles.notice}><strong>Wyłącznie ręczna.</strong> System nie podpowiada, nie wybiera ani nie zapisuje żadnej decyzji bez działania użytkownika. Każda decyzja wymaga uzasadnienia.</p>
    {canEdit&&<div className={styles.noPrint}>
      <label>Decyzja
        <select value={decision} onChange={e=>setDecision(e.target.value)}>
          <option value="">— Wybierz ręcznie —</option>
          {Object.entries(decisionLabels).map(([value,label])=><option value={value} key={value}>{label}</option>)}
        </select>
      </label>
      <label>Uzasadnienie (wymagane)
        <textarea rows={4} value={justification} maxLength={10000} onChange={e=>setJustification(e.target.value)}/>
      </label>
      <button type="button" disabled={!decision||!justification.trim()||!!pending}
        onClick={()=>act('decision',{action:'decision',decision,justification})}>Zapisz decyzję człowieka</button>
    </div>}
    {decisions.length===0?<p>Brak decyzji.</p>:<ol>{decisions.map(d=><li key={d.id}>
      <strong>{decisionLabels[d.decision]}</strong> — {d.justification}
      <p className={styles.metadata}>Autor: {d.decided_by}; {stamp(d.decided_at)}</p>
    </li>)}</ol>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
