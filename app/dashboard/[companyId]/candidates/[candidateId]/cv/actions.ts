"use server";
import { revalidatePath } from "next/cache";
import { companyAccess } from "../../../../../../lib/company-access";
import { readCvInput, suggestRedaction, validateCvText } from "../../../../../../lib/cv-text";
import type { EditorState } from "../../../../../../lib/position-fields";

const path = (companyId: string, candidateId: string) => `/dashboard/${companyId}/candidates/${candidateId}/cv`;
const failed = "Nie udało się zapisać CV. Sprawdź, czy moduł CV jest już uruchomiony. Dane pozostały w formularzu.";

export async function addCv(companyId: string, candidateId: string, _state: EditorState, form: FormData): Promise<EditorState> {
  const {client,canEdit} = await companyAccess(companyId);
  if (!canEdit) return {error:"Masz dostęp tylko do odczytu."};
  const {data:candidate,error} = await client.from('candidates').select('first_name,last_name').eq('company_id',companyId).eq('id',candidateId).maybeSingle();
  if (error || !candidate) return {error:"Nie znaleziono kandydata w tej firmie."};
  let source_text;
  try { source_text = await readCvInput(form); }
  catch (error) { return {error: error instanceof Error ? error.message : "Sprawdź tekst CV."}; }
  const redacted_text = suggestRedaction(source_text,[candidate.first_name,candidate.last_name]);
  const result = await client.from('candidate_documents').insert({company_id:companyId,candidate_id:candidateId,source_text,redacted_text});
  if(result.error) return {error:failed};
  revalidatePath(path(companyId,candidateId));
  return {saved:true};
}

export async function editCv(companyId: string, candidateId: string, documentId: string, version: number, _state: EditorState, form: FormData): Promise<EditorState> {
  const {client,canEdit} = await companyAccess(companyId);
  if (!canEdit) return {error:"Masz dostęp tylko do odczytu."};
  let redacted_text;
  try { redacted_text = validateCvText(String(form.get('redacted_text') ?? '')); }
  catch(error) {return {error:error instanceof Error ? error.message : "Sprawdź tekst."};}
  const result = await client.from('candidate_documents').update({redacted_text}).eq('company_id',companyId).eq('candidate_id',candidateId).eq('id',documentId).eq('version',version).select('id').maybeSingle();
  if(result.error) return {error:failed};
  if(!result.data) return {error:"Dokument zmienił się w innym oknie. Skopiuj swoje poprawki, odśwież stronę i porównaj wersje."};
  revalidatePath(path(companyId,candidateId));
  return {saved:true};
}

export async function reviewCv(companyId: string, candidateId: string, documentId: string, version: number, _state: EditorState, form: FormData): Promise<EditorState> {
  const {client,canEdit} = await companyAccess(companyId);
  if (!canEdit) return {error:"Masz dostęp tylko do odczytu."};
  if(form.get('confirmed') !== 'on') return {error:"Najpierw sprawdź tekst i potwierdź usunięcie danych identyfikujących."};
  const {data,error} = await client.from('candidate_documents').select('id').eq('company_id',companyId).eq('candidate_id',candidateId).eq('id',documentId).maybeSingle();
  if(error || !data) return {error:"Nie znaleziono dokumentu."};
  const result = await client.rpc('review_candidate_document',{document_id:documentId,expected_version:version});
  if(result.error) return {error:failed};
  if(!result.data) return {error:"Dokument zmienił się. Odśwież stronę i sprawdź najnowszą wersję przed zatwierdzeniem."};
  revalidatePath(path(companyId,candidateId));
  return {saved:true};
}
