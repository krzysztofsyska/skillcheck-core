# Manifest promocji origin/integration → origin/main

Wygenerowano narzędziem `tools/release/promotion-manifest.mjs` (tylko odczyt lokalnego Git).

- Kandydat (head): `6c3230297d3908bb10e1b406fc622932b8d1b78a`
- Produkcja (base): `a474846a1a4f6630310582647e196223b7364c51`
- Commity: **430**, przypisane do PR: **430**, nieprzypisane: **0**
- Pliki: **470**; nowe migracje: **24**
- Hash manifestu (sha256): `9f8f94d2148d4b106b3e57542c2e48a9ddba8a3deb09d08c94f3bb80e07deb06`

Manifest jest dowodem do przeglądu właściciela. Nie zastępuje rejestru ACCEPTED kontrolera i niczego nie autoryzuje.

## Kategorie plików

| Kategoria | Pliki |
| --- | ---: |
| tests | 134 |
| backend | 95 |
| frontend | 81 |
| tooling | 43 |
| docs | 38 |
| supabase-other | 28 |
| migration | 24 |
| ci-governance | 17 |
| api | 5 |
| runtime-config | 3 |
| other | 2 |

## Nowe migracje (kolejność repozytorium)

1. `supabase/migrations/20261103090000_sc19_auto_trial_marketing_consent.sql`
2. `supabase/migrations/20261103090100_sc_erasure_inventory_r11.sql`
3. `supabase/migrations/20261103130000_sc019_checkout_offers_read.sql`
4. `supabase/migrations/20261104080000_pricing_catalog.sql`
5. `supabase/migrations/20261104120000_position_requirement_flags.sql`
6. `supabase/migrations/20261106063720_sc_wer_c1_inventory_r12.sql`
7. `supabase/migrations/20261106065733_sc_wer_broker_limiter.sql`
8. `supabase/migrations/20261106070123_sc_wer_staff_access.sql`
9. `supabase/migrations/20261106120000_sc_ac_inventory_r13.sql`
10. `supabase/migrations/20261106130000_exercise_ai_proposals.sql`
11. `supabase/migrations/20261106140000_exercise_ai_grant_guard.sql`
12. `supabase/migrations/20261106150000_exercise_ai_recruiter_api.sql`
13. `supabase/migrations/20261106230000_cv_bulk_global_capacity_lock.sql`
14. `supabase/migrations/20261106231000_cv_bulk_uploading_scheduler.sql`
15. `supabase/migrations/20261107164219_exercise_ai_revision_workflow.sql`
16. `supabase/migrations/20261107164252_sc019_catalog_orders.sql`
17. `supabase/migrations/20261107170432_single_analysis_preselection_group.sql`
18. `supabase/migrations/20261107171053_exercise_ai_generation.sql`
19. `supabase/migrations/20261109190000_sc020_brand_configuration.sql`
20. `supabase/migrations/20261109200000_sc020_customer_domains.sql`
21. `supabase/migrations/20261109210000_sc021_ai_ledger.sql`
22. `supabase/migrations/20261109220000_sc020d_domain_reverification.sql`
23. `supabase/migrations/20261109230000_sc021_ai_budgets.sql`
24. `supabase/migrations/20261110090000_sc021_cost_dashboard.sql`

## Przypisania spoza tytułu commita

Commit bez numeru PR w tytule przypisany jawnym wpisem w narzędziu (dane, nie reguła):

- `0632e05ad5c8ca9b695c9550ecd73145452424a5` → #356. GitHub API repos/krzysztofsyska/skillcheck-core/commits/0632e05ad5c8ca9b695c9550ecd73145452424a5/pulls lists #356 (base integration, merged 2026-11-08T12:39:52Z); the commit time is 2026-11-08 13:39:52 +0100, the same second. The only other PR listed for it is the open promotion PR #266.

## Kroki historii integration (chronologicznie)

| # | Commit | PR | Commity | Migracje | Tytuł PR |
| ---: | --- | --- | ---: | :---: | --- |
| 1 | `acf2b30` | #259 | 7 |  | docs: triage RLS na skillcheck-preview (tylko odczyt) |
| 2 | `2aa72a3` | #263 | 1 | tak | SC-P24-VERIFY-001: ścieżka zakupowa pod weryfikację Przelewy24 |
| 3 | `53ea059` | #264 | 9 |  | feat(buy): widoczny przycisk „Kup PRESELEKCJĘ" i ekran zakupu pakietu |
| 4 | `1010720` | #265 | 4 | tak | SC-PRICING-W1/W2: audyt źródeł cennika i katalog cen w bazie |
| 5 | `81c0457` | #262 | 21 | tak | SC-FREE-AUTO-001 + SC-CONSENT-001 + SC-DIGEST-001: automatyczne FREE z białej listy VAT, zgoda na kontakt handlowy, dzienne podsumowanie |
| 6 | `7f172d7` | #267 | 3 |  | fix(buy): cel zakupu przeżywa potwierdzenie adresu e-mail (uwaga bota z #266) |
| 7 | `2cf1b66` | #279 | 3 |  | SC19-P24-PREVIEW: testowa płatność PRESELEKCJI przez Sandbox Przelewy24 |
| 8 | `aea2bc9` | #280 | 2 |  | SC19-P24-PREVIEW: zaufane certyfikaty Supabase dla kasy testowej |
| 9 | `726136f` | #282 | 3 |  | Nawigacja z konta do oferty i zakupu kolejnego pakietu |
| 10 | `e92a5ee` | #278 | 3 |  | Przekazanie Codexowi prac programistycznych w całym SkillCheck |
| 11 | `cb3352e` | #269 | 8 | tak | feat(sc-015): raport FREE kandydata i porównanie wymagań do pięciu CV (#268) |
| 12 | `df97a4b` | #273 | 13 | tak | feat(sc-wer-001): test kompetencyjny od zaproszenia do raportu (#270) |
| 13 | `76ede49` | #272 | 22 | tak | feat(sc-ac-001): aktywne arkusze Assessment Center i raport dowodów (#271) |
| 14 | `86490aa` | #287 | 5 |  | SC-019: zakup PRESELEKCJI z ekranu rekrutacji i bezpieczny powrót |
| 15 | `0f8249f` | #286 | 6 |  | SC-PRICING-W2b (1/2): pula CV liczona z katalogu, krok 5 |
| 16 | `64faa52` | #285 | 7 |  | SC-014-C6 (1/3): warstwa czysta generatora zadania kompetencyjnego |
| 17 | `7dda9d2` | #290 | 1 |  | fix(SC-015): ostrzeżenie przy pustej macierzy dowodów w raporcie FREE |
| 18 | `22bd632` | #289 | 4 |  | docs: Assessment Center odmrożony decyzją właściciela 2026-11-06 |
| 19 | `400aaac` | #291 | 8 | tak | SC-014-C6 (2a): propozycje AI i bezpieczny cykl życia z inwentarzem R14 |
| 20 | `a17fd04` | #293 | 3 | tak | SC-014 C6: blokada dostępu kandydata przed zatwierdzeniem AI |
| 21 | `effc04f` | #292 | 8 | tak | fix(SC-005/SC-BULK): globalny limit równoległych analiz między firmami (#233) |
| 22 | `70fb049` | #294 | 15 |  | fix(SC-005): OCR skanowanych CV z cyfrowym nagłówkiem (#233) |
| 23 | `1e1fccb` | #295 | 3 |  | fix(SC-005): nie loguj danych CV z błędów parsera OCR |
| 24 | `c1a4c7d` | #296 | 3 | tak | SC-014 C6: API rekrutera do odczytu i zatwierdzania propozycji |
| 25 | `5060ea8` | #297 | 5 | tak | SC-005: podpisany scheduler przetwarza CV podczas wgrywania paczki |
| 26 | `f2fc81a` | #298 | 4 |  | SC-005: deduplikacja identyfikatorów analiz przed wysyłką do workera |
| 27 | `e628b69` | #299 | 3 |  | SC-005: nie ukrywaj błędów potwierdzenia powiadomień w pompie CV |
| 28 | `9e015e5` | #300 | 3 |  | SC-005: odrzucenie niekompletnej odpowiedzi RPC paczki CV |
| 29 | `9dc3d1c` | #301 | 5 |  | SC-005: signed scheduler fails closed for malformed claimed batch |
| 30 | `aa09d2e` | #302 | 3 |  | SC-005: wymagaj potwierdzenia zamknięcia powiadomienia paczki CV |
| 31 | `564190f` | #303 | 5 |  | SC-005: odrzucaj niekompletne potwierdzenia rejestracji paczki CV |
| 32 | `8ed6bf4` | #304 | 3 |  | SC-005: deduplikacja zleceń harmonogramu między paczkami |
| 33 | `f75b026` | #305 | 6 |  | SC-005: wymagaj potwierdzenia zapisu ręcznej grupy preselekcji |
| 34 | `8477f4b` | #306 | 4 |  | SC-005: fail closed when screening ranking pages are inconsistent |
| 35 | `2f3b660` | #307 | 4 |  | SC-015: fail closed on duplicate or unbound candidate evidence rows |
| 36 | `47bb04a` | #308 | 3 |  | SC-015 FREE: odrzucanie niespójnej historii akceptacji CV |
| 37 | `8bf24df` | #309 | 7 |  | SC-015 FREE: walidacja odpowiedzi RPC oznaczeń wymagań |
| 38 | `728d887` | #310 | 4 |  | fix(SC-005): canonical UUID currency for bulk preselection groups |
| 39 | `97942a9` | #311 | 3 |  | fix(SC-005): do not present unreviewed bulk groups as current |
| 40 | `f3eaaf3` | #312 | 3 |  | fix(SC-005): deterministic pagination of preselection ranking |
| 41 | `d02d176` | #288 | 8 |  | SC-019: zachowanie kontekstu rekrutacji w katalogu zakupowym |
| 42 | `cea30ca` | #313 | 2 |  | SC-019: powrót do rekrutacji po płatności testowej |
| 43 | `0a50d8a` | #314 | 3 |  | fix(SC-005): odczyt pełnego rankingu przy limitach odpowiedzi RPC |
| 44 | `4a12116` | #315 | 1 |  | fix(SC-005): nie potwierdzaj niekompletnych powiadomień paczki CV |
| 45 | `99c745f` | #316 | 1 |  | fix(SC-005): weryfikacja partii i liczników przed powiadomieniem CV |
| 46 | `05b0c39` | #317 | 1 |  | fix(SC-005): bind signed CV notification to worker batch UUID |
| 47 | `27a31ac` | #318 | 1 |  | fix(SC-005): fail closed on duplicate bulk preselection group report rows |
| 48 | `46faeb3` | #319 | 1 |  | fix(SC-005): reject repeated signed scheduler batch leases |
| 49 | `063f8bd` | #320 | 1 |  | fix(SC-005): unify recruitment group currency checks |
| 50 | `7d60bfd` | #321 | 1 |  | fix(SC-015): reject mid-read review changes in FREE report |
| 51 | `17c52dc` | #323 | 3 |  | SC-019: podgląd opublikowanego katalogu w panelu firmy |
| 52 | `dbd1777` | #322 | 4 |  | SC-014-C6: podgląd i zatwierdzanie propozycji zadania przez rekrutera |
| 53 | `738545c` | #324 | 1 |  | fix(SC-015 FREE): fail closed on unreviewed comparison evidence |
| 54 | `c9730c0` | #325 | 1 |  | test(FREE): cover exhausted trial, bulk CVs and five report routes |
| 55 | `310f9dc` | #329 | 1 |  | fix(SC-019): clarify online and assisted package checkout |
| 56 | `711c546` | #326 | 7 | tak | feat(SC-014 C6): atomic proposal editing and rejection with history |
| 57 | `1610a98` | #334 | 1 |  | fix(SC-015): match requirement snapshots consistently in FREE comparison |
| 58 | `5b2cc11` | #333 | 1 |  | Pokaż zakres i przykłady planowanych pakietów Weryfikacja i AC |
| 59 | `4db85e2` | #335 | 1 |  | fix(SC-015): detect concurrent evidence changes in FREE report |
| 60 | `41b9042` | #337 | 1 |  | Hold shared Preview during payment testing |
| 61 | `40a3cbb` | #339 | 1 |  | fix(SC-005): protect CSV exports from invisible formula prefixes |
| 62 | `fa72bb7` | #330 | 9 | tak | fix(SC-005): add provisional groups to individual completed analyses |
| 63 | `1258c93` | #328 | 16 | tak | feat(SC-019): catalog orders, upgrades and metered test fulfillment |
| 64 | `185ca48` | #340 | 1 |  | fix(SC-011): reject out-of-range Retell webhook timestamps |
| 65 | `1da6e35` | #341 | 1 |  | fix(SC-015): fail closed on concurrent human-review edits in screening reports |
| 66 | `ca926ee` | #342 | 1 |  | fix(SC-005): nie pokazuj nieaktualnej punktacji grup preselekcji |
| 67 | `94cc6c8` | #343 | 1 |  | fix(SC-015): reject fabricated CV citation ranges and null evidence snapshots |
| 68 | `ce6cc53` | #344 | 1 |  | fix(SC-015): validate evidence quote offsets in candidate comparison |
| 69 | `4cf3c59` | #345 | 1 |  | fix(SC-BULK): block misleading CV filenames and ZIP metadata paths |
| 70 | `cce28e7` | #346 | 1 |  | fix(SC-005): fail closed on malformed report pagination responses |
| 71 | `1441f45` | #347 | 1 |  | fix(SC-005): zachowaj krótkie kwalifikacje odczytane OCR |
| 72 | `ee05db4` | #348 | 1 |  | fix(SC-BULK): ignore hidden and mixed-case ZIP metadata folders |
| 73 | `989da50` | #349 | 1 |  | fix(SC-005): fail closed on out-of-recruitment preselection groups |
| 74 | `1ac21b0` | #350 | 1 |  | fix(SC-BULK): fail closed on residual candidate name after CV redaction |
| 75 | `e590cd1` | #351 | 1 |  | fix(SC-005): reject cross-tenant report source relationships |
| 76 | `6d517a9` | #352 | 1 |  | fix(SC-019): distinguish checkout availability from assisted proforma |
| 77 | `e874748` | #353 | 1 |  | fix(SC-005): reject coerced model evidence quotes |
| 78 | `bcfe3fc` | #332 | 8 | tak | feat(SC-014): reserve and generate exercise proposals with explicit approval |
| 79 | `6117ef5` | #357 | 1 |  | fix(SC-019): zachowaj kontekst rekrutacji przy zakupie z nagłówka panelu |
| 80 | `0632e05` | #356 | 1 |  | fix(SC-BULK): bind manual preselection move to company/recruitment |
| 81 | `353c4ea` | #358 | 1 |  | fix(SC-014/016): validate company and recruitment links in exercise context |
| 82 | `dc7f529` | #359 | 1 |  | fix(SC-005): reject incomplete human evidence matrix in reports |
| 83 | `d9b5597` | #354 | 1 |  | fix(SC-005): validate tenant and CV links in screening context |
| 84 | `89f8f09` | #360 | 1 |  | docs(SC-CONTEXT): mark historical backlog and current entrypoint (#355) |
| 85 | `ebb6e63` | #361 | 3 |  | fix(SC-BULK): wiąż paczki CV z firmą i rekrutacją w adresie |
| 86 | `730480a` | #369 | 1 |  | SC-AUTO-RELEASE: polityka ciągłych wydań (#369, krok 1) (#370) |
| 87 | `d987a46` | #362 | 1 |  | SC-BULK-ACTIONS: testy wykonania createBulkBatch/closeBulkUpload/bulkProgress (#362) (#368) |
| 88 | `f019bf3` | #369 | 1 |  | SC-AUTO-RELEASE: read-only collector feeding evaluateAutoRelease (#369 stage 3) (#372) |
| 89 | `732e3da` | #364 | 1 |  | SC-BULK-CLOSE-UX: show unconfirmed close and retry only close (#364) (#371) |
| 90 | `47d35ca` | #369 | 1 |  | SC-AUTO-RELEASE: read-only GitHub readers for the collector (#369 stage 4a) (#373) |
| 91 | `e355b34` | #363 | 1 |  | test(bulk): real-HTTP isolation test for CV batch progress page (#363) (#374) |
| 92 | `79b15e5` | #375 | 5 |  | SC-OPS — obowiązkowe zakończenie CI i pełny przegląd commitów przed merge |
| 93 | `e11658b` | #377 | 9 |  | SC-OPS — adapter Claude Code do istniejącej kolejki i pętli review |
| 94 | `700ac17` | #376 | 4 |  | SC-BULK-POLL-UX — komunikat o utraconym odświeżaniu paczki i sprzątanie pollingu (#365) |
| 95 | `bcbdf6b` | #366 | 1 |  | SC-AC-REPORT-HTTP: real-HTTP isolation test for AC exercise report page (#366) (#378) |
| 96 | `b2b2461` | #381 | 4 |  | SC-021-A: wielodostawcowy AI Gateway (aktywny tylko OpenAI) |
| 97 | `efc58bd` | #383 | 3 |  | SC-021-A2: screening i generowanie zadań przez AI Gateway (za flagą, wyłączoną) |
| 98 | `652e35d` | #379 | 6 |  | SC-OPS: uruchamianie kontrolera niezależnie od wydania produkcji |
| 99 | `64a9b3a` | #382 | 10 | tak | SC-020-A: wersjonowana konfiguracja marki firmy (white-label) |
| 100 | `0385f1c` | #384 | 1 | tak | SC-020-B: domeny klienta (subdomena / własna domena, weryfikacja DNS, routing po hoście) |
| 101 | `9a87e20` | #386 | 4 |  | SC-OPS: odczytowy test widoczności ochron GitHub |
| 102 | `ef10728` | #387 | 7 |  | SC-020-C: wiadomości do kandydatów i raporty w marce klienta |
| 103 | `cb3a52d` | #385 | 6 | tak | SC-021-B: rejestr prób i kosztów AI (ledger) |
| 104 | `fc64a2c` | #389 | 3 |  | SC-OPS: bezpieczny test widoczności ochron przez istniejącą App |
| 105 | `2e10f99` | #388 | 1 | tak | SC-020-D: izolacja i bezpieczeństwo white-label (marka + domeny) |
| 106 | `e05e05c` | #390 | 7 | tak | SC-021-C: budżety kosztów AI (80% ostrzeżenie, 100% blokada) |
| 107 | `0d3766c` | #392 | 6 | tak | SC-021-D: panel kosztów AI i marży |
| 108 | `ff131d9` | #380 | 8 |  | SC-AUTO-RELEASE #369 etap 4a+4b: czytniki read-only i dowód Codex per zadanie |
| 109 | `29cb030` | #391 | 1 |  | SC-P24-VERIFY-002: „Regulamin sklepu” w stopce, strona Kontakt, podsumowanie płatności i reklamacji |
| 110 | `042e181` | #394 | 1 |  | chore(sc020): brakujące skrypty cofania migracji + test parzystości |
| 111 | `760bad4` | #395 | 1 |  | fix(sc020): NOWAIT w blokadach rollbacków — zakleszczenie z aplikacją |
| 112 | `d9e1a79` | #393 | 1 |  | SC-AUTO-RELEASE #369 etap 4c: czytnik dowodu CI (read-only) |
| 113 | `f95bbd2` | #396 | 1 |  | fix(sc020): skrócone okno powstania zakleszczenia w rollbackach SC-020-A/B |
| 114 | `139a2fc` | #398 | 1 |  | Ukryj pakiety WERYFIKACJA i ASSESSMENT CENTER na stronach publicznych (P24) |
| 115 | `bfb6582` | #401 | 3 |  | Próba generalna migracji od rzeczywistego stanu produkcji (49 migracji) |
| 116 | `7ab88a2` | #403 | 1 |  | Poprawka skryptu cofania SC-WER r12 + test od stanu produkcji |
| 117 | `463e0ed` | #405 | 1 |  | Bramka --check dla wszystkich generatorów SQL |
| 118 | `0af3309` | #408 | 1 |  | Zdejmij blokadę podglądu: integration znów buduje Preview |
| 119 | `16752f6` | #409 | 1 |  | Drop the voice annex from the mandatory registration consent (r2) |
| 120 | `6c32302` | #410 | 1 |  | Withdraw the voice annex (Aneks nr 1) from publication and archive it |
