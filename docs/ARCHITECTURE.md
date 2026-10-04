# SkillCheck — Architecture Baseline

Status: obowiązujący punkt odniesienia po merge PR #1 (2026-10-04).

## Stack
- Next.js 16 + React 19 + TypeScript
- Supabase Auth + PostgreSQL + RLS
- Vercel
- GitHub jako source of truth
- OpenAI API: etap kolejny, jeszcze nie aktywny w produkcyjnym flow

## Zasada architektoniczna
SkillCheck jest aplikacją multi-tenant. Każdy rekord operacyjny należy do firmy przez `company_id`; RLS jest końcową warstwą izolacji. Nie używać service_role w kodzie aplikacji.

## Istniejący fundament
Już zaimplementowane:
- auth, recovery i onboarding firmy,
- company profile,
- positions / profil stanowiska „Kogo potrzebujesz?”,
- recruitments,
- candidates i applications,
- import CV TXT/PDF/DOCX,
- redakcja/anonimizacja zatwierdzana przez człowieka,
- przygotowanie danych do preselekcji,
- ręczne etapy i notatki,
- behavior assessments z historią,
- interview guide,
- wersjonowane exercise definitions,
- exercise observations,
- testy RLS, auth, CV, screening, assessments i HTTP.

Nie implementować ponownie powyższych modułów bez osobnego tasku naprawczego.

## Główne encje
`companies -> company_profiles`
`companies -> company_members`
`companies -> positions -> recruitments -> applications`
`companies -> candidates -> applications`
`candidates -> candidate_documents`
`recruitments/applications -> assessment stages / assessments / exercises / observations`

## Kontrakty, których nie wolno łamać bez tasku L3
1. `company_id` i izolacja tenantów.
2. RLS jako warstwa obowiązkowa.
3. Oryginalne CV nie trafia do zewnętrznego AI; AI może dostać wyłącznie zatwierdzony materiał preselekcji.
4. Wynik AI nie jest automatyczną decyzją o zatrudnieniu.
5. Zmiana danych wejściowych unieważnia/stale'uje wynik analizy.
6. Migracji już wykonanych na Supabase nie uruchamiać ponownie.
7. Krytyczne mutacje muszą przechodzić przez walidację serwerową/RPC zgodnie z istniejącym wzorcem.

## Następne warstwy
1. Stabilizacja po merge i aktualizacja dokumentacji.
2. Persistowany wynik preselekcji AI + review człowieka.
3. Ranking/shortlista i raport rekrutacji.
4. Candidate communication + voicebot.
5. Test kompetencji / pełne AC.
6. Quality of Hire.
7. Talent pool.
8. Billing i pakiety.
9. White-label.

## Zasada zmian
Każda większa zmiana powstaje na branchu, w jednym numerowanym tasku SC-XXX, z kryteriami akceptacji, testami i PR. Nie łączyć niepowiązanych funkcji w jednym PR.
