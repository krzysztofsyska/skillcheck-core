import { hrbpCaseTemplate } from '../../lib/assessment-center-session-template.ts';

// Synthetic `public.ac_session_read` payload shared by the pure and the HTTP test. No real people.
export const ids = {
  session: '90000000-0000-4000-8000-000000000001', recruitment: '90000000-0000-4000-8000-000000000002',
  owner: '90000000-0000-4000-8000-000000000010', recruiter: '90000000-0000-4000-8000-000000000011',
  applicationA: '90000000-0000-4000-8000-000000000021', applicationB: '90000000-0000-4000-8000-000000000022',
  stage: index => `90000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
  definition: index => `90000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`,
  pair: index => `90000000-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`,
};
const at = minute => `2026-11-12T09:${String(minute).padStart(2, '0')}:00+00:00`;
const observation = (criterionIndex, rating, note) => rating === 'insufficient_data'
  ? { criterionIndex, rating, evidence: '', context: '' }
  : { criterionIndex, rating, evidence: `${note} — syntetyczna obserwacja kryterium ${criterionIndex + 1}.`, context: 'Sesja AC, dane syntetyczne.' };
const sheets = (first, second) => [
  { authorId: ids.owner, submittedAt: at(10), observations: first.map((rating, index) => observation(index, rating, 'AsesorPierwszy')) },
  { authorId: ids.recruiter, submittedAt: at(12), observations: second.map((rating, index) => observation(index, rating, 'AsesorDrugi')) },
];
const entry = (kind, body, authorId, minute) => ({ kind, body, authorId, createdAt: at(minute) });

export function sessionPayload({ status = 'open' } = {}) {
  const stages = hrbpCaseTemplate.stages.map((stage, index) => ({ id: ids.stage(index), ordinal: index + 1, type: stage.type, title: stage.title,
    definitionId: ids.definition(index), definition: stage.definition, counterpartBrief: stage.counterpartBrief }));
  const empty = index => ({ stageId: ids.stage(index), entries: [], pair: { state: 'unassigned' } });
  return {
    session: { id: ids.session, recruitmentId: ids.recruitment, title: hrbpCaseTemplate.title, status,
      plannedCompetencies: hrbpCaseTemplate.plannedCompetencies, uncoveredCompetencies: [], createdAt: at(0),
      openedAt: status === 'draft' ? null : at(1), closedAt: status === 'closed' ? at(50) : null, finalistLimit: 10, recommendedFinalists: [5, 6] },
    stages,
    finalists: [{
      applicationId: ids.applicationA, slot: 1,
      expertNotes: [{ note: 'NotatkaEksperta: omówiono rozbieżność w planie zmiany.', authorId: ids.owner, createdAt: at(40) }],
      stages: [
        { stageId: ids.stage(0),
          entries: [entry('first_attempt', { work: 'PierwszaProba: lista objawów rotacji bez danych.' }, ids.recruiter, 5),
            entry('feedback', { feedback: 'InformacjaZwrotna: oddziel przyczyny od objawów.' }, ids.owner, 20),
            entry('revised_attempt', { work: 'PoprawionaPraca: przyczyny potwierdzone danymi o absencji.' }, ids.recruiter, 30),
            entry('change_proof', { changes: 'OpisZmiany: dodano tabelę przyczyn z danymi.', evidence: 'DowodZmiany: tabela przyczyn w poprawionej pracy.', assessment: 'change_confirmed' }, ids.owner, 35)],
          pair: { state: 'ready', pairId: ids.pair(0), definitionId: ids.definition(0), sheets: sheets(['above'], ['meets']),
            reconciliation: { items: [{ criterionIndex: 0, outcome: 'agreed', rating: 'meets', justification: 'UzasadnienieUzgodnienia po rozmowie asesorów.', firstRating: 'above', secondRating: 'meets' }],
              recordedBy: ids.recruiter, recordedAt: at(15), confirmation: 'confirmed', confirmedBy: ids.owner, confirmedAt: at(16), disputeNote: null } } },
        { stageId: ids.stage(1), entries: [], pair: { state: 'pending', pairId: ids.pair(1), ownSubmitted: false } },
        { stageId: ids.stage(2), entries: [],
          pair: { state: 'ready', pairId: ids.pair(2), definitionId: ids.definition(2), sheets: sheets(['below', 'meets'], ['above', 'insufficient_data']),
            reconciliation: { items: [{ criterionIndex: 0, outcome: 'discrepancy', note: 'OpisRozbieznosci: asesorzy pozostali przy swoich ocenach.', firstRating: 'below', secondRating: 'above' },
              { criterionIndex: 1, outcome: 'agreed', rating: 'meets', justification: 'UzasadnienieDrugie po rozmowie asesorów.', firstRating: 'meets', secondRating: 'insufficient_data' }],
              recordedBy: ids.owner, recordedAt: at(25), confirmation: null, confirmedBy: null, confirmedAt: null, disputeNote: null } } },
        empty(3),
      ],
    }, { applicationId: ids.applicationB, slot: 2, expertNotes: [], stages: stages.map((_, index) => empty(index)) }],
  };
}
