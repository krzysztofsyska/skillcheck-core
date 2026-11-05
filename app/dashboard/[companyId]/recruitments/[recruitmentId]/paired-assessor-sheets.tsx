import { revalidatePath } from 'next/cache';
import { loadBehaviorContext, type BehaviorRoute } from '../../../../../lib/behavior-context';
import { behaviorRatings } from '../../../../../lib/behavior-assessment';
import { type ExerciseDefinition } from '../../../../../lib/exercise-definition';
import type { Json } from '../../../../../lib/supabase/database.types';

function previewEnabled() {
  return process.env.AC_PAIRED_SHEETS_PREVIEW === 'true' &&
    (process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development');
}
function record(value:Json|undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function PairedAssessorSheets({route,definition}:{
  route:BehaviorRoute & {definitionId:string}; definition:ExerciseDefinition;
}) {
  if (!previewEnabled() || definition.kind !== 'assessment_center') return null;
  const {client,company,user,canEdit} = await loadBehaviorContext(route);
  if (!canEdit) return null;
  const args = {application:route.applicationId,revision:route.definitionId};
  const path = '/dashboard/'+route.companyId+'/recruitments/'+route.recruitmentId+'/applications/'+route.applicationId+'/exercises/'+route.definitionId;
  const pair = await client.rpc('ac_find_pair',args);
  if (pair.error) return <p>Arkusze dwóch asesorów są niedostępne w tym środowisku.</p>;
  if (!pair.data) {
    if (company.owner_id !== user.id) return null;
    const members = await client.from('company_members').select('user_id').eq('company_id',company.id).eq('role','recruiter');
    if (members.error) return <p>Nie udało się wczytać asesorów.</p>;
    const ids = Array.from(new Set([user.id,...members.data.map(row=>row.user_id)]));
    if (ids.length < 2) return <p>Do niezależnej oceny potrzeba dwóch asesorów z dostępem do rekrutacji.</p>;
    const assign = async (form:FormData) => {
      'use server';
      if (!previewEnabled()) throw new Error('Arkusze niedostępne.');
      const {client} = await loadBehaviorContext(route);
      const first=String(form.get('first')), second=String(form.get('second'));
      if (first===second) throw new Error('Wybierz dwie różne osoby.');
      const result=await client.rpc('ac_assign_pair',{...args,first_id:first,second_id:second});
      if (result.error) throw new Error('Nie udało się przypisać asesorów. Sprawdź aktualny skład zespołu.');
      revalidatePath(path);
    }
    return <section><h2>Niezależne arkusze asesorów</h2><form action={assign}>
      {['first','second'].map((name,i)=><label key={name}>Asesor {i+1}
        <select name={name} defaultValue={ids[i]}>{ids.map(id=><option value={id} key={id}>{id===user.id?'Ty':id}</option>)}</select>
      </label>)}<button>Przypisz asesorów</button>
    </form></section>;
  }
  const id=pair.data;
  const result=await client.rpc('ac_read_pair',{pair_id:id});
  const report=record(result.data);
  if (result.error || !report) return <p>Nie udało się wczytać arkuszy.</p>;
  if (report.state==='ready' && Array.isArray(report.sheets)) {
    const sheets=report.sheets;
    return <section><h2>Porównanie dwóch arkuszy</h2>{definition.criteria.map((c,i)=>{
      const ratings=sheets.map(sheet=>{
        const rows=record(sheet)?.observations;
        return Array.isArray(rows)?record(rows[i])?.rating:null;
      });
      return <article key={i}><h3>{c.competency}</h3>
        {ratings.length===2 && ratings[0]!==ratings[1] && <p>Różne oceny asesorów</p>}
        {sheets.map((sheet,j)=>{
        const observations=record(sheet)?.observations;
        const item=Array.isArray(observations)?record(observations[i]):null;
        const author = record(sheet)?.authorId;
        return <div key={j}><strong>Asesor {j+1}{typeof author==='string' && ' · '+(author===user.id?'Ty':author)}</strong>
          <p>{behaviorRatings.find(([value])=>value===item?.rating)?.[1]}</p>
          {typeof item?.evidence==='string' && <p className="cv-text">{item.evidence}</p>}
          {typeof item?.context==='string' && item.context && <p>Okoliczności: {item.context}</p>}</div>;
      })}</article>})}</section>;
  }
  if (report.state!=='pending' || report.ownSubmitted!==false)
    return <p>Porównanie będzie dostępne po oddaniu obu arkuszy.</p>;
  async function submit(form:FormData) {
    'use server';
    if (!previewEnabled()) throw new Error('Arkusze niedostępne.');
    const {client}=await loadBehaviorContext(route);
    const observations=definition.criteria.map((_,i)=>({criterionIndex:i,
      rating:String(form.get('rating'+i)),evidence:String(form.get('evidence'+i)??'').trim(),
      context:String(form.get('context'+i)??'').trim()}));
    const saved=await client.rpc('ac_submit_sheet',{pair_id:id,sheet:observations});
    if (saved.error) throw new Error('Nie zapisano arkusza. Sprawdź dowody i aktualny stan oceny.');
    revalidatePath(path);
  }
  return <section><h2>Twój niezależny arkusz</h2>
    <p>Przy ocenie wpisz dowód (co najmniej 10 znaków) oraz kontekst obserwacji (co najmniej 5 znaków). Przy braku danych pozostaw dowód pusty. Po oddaniu arkusz zostaje zamknięty.</p>
    <form action={submit}>{definition.criteria.map((c,i)=><fieldset key={i}><legend>{c.competency}</legend>
      <label>Ocena<select name={'rating'+i} defaultValue="insufficient_data">{behaviorRatings.map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>
      <label>Dowód<textarea name={'evidence'+i} maxLength={4000}/></label>
      <label>Kontekst obserwacji<textarea name={'context'+i} maxLength={2000}/></label>
    </fieldset>)}<button>Oddaj swój arkusz</button></form></section>;
}
