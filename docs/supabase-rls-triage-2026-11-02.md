# Triage RLS — `skillcheck-preview`, 2026-11-02

**Projekt:** `skillcheck-preview` (`orbyscrupgnupifzlqxp`), Postgres 17.11
**Zakres:** schematy `public`, `private`, `checkout`
**Tryb:** wyłącznie odczyt. Nie uruchomiono żadnej migracji ani `DDL`; nie zmieniono niczego w bazie.
**Metoda:** zapytania do katalogu systemowego (`pg_class`, `pg_policy`, `pg_proc`,
`information_schema.role_table_grants`) plus odczyt definicji funkcji przez `pg_get_functiondef`.
Wynik porównany z Supabase Security Advisor — liczby się zgadzają (46 tabel, 10 funkcji
`SECURITY DEFINER` dostępnych dla `anon`, 75 dla `authenticated`).

---

## Wniosek na jedno zdanie

**Nie znalazłem tabeli z danymi kandydatów, do której klient z rolą `authenticated` miałby dostęp
mimo braku polityki RLS.** Wszystkie 46 tabel bez polityk nie ma też **żadnego uprawnienia** dla
ról `anon` i `authenticated`, więc brak polityki oznacza tam „odmawiaj zawsze", a nie „wpuszczaj
każdego". Dostęp idzie wyłącznie przez funkcje `SECURITY DEFINER`, a każda z tych, które dotykają
danych osobowych, ma działającą kontrolę uprawnień. Poniżej dowody i trzy rzeczy, które mimo to
warto domknąć.

---

## 1. Dlaczego 46 tabel bez polityk nie jest tu dziurą

Supabase Advisor zgłasza `rls_enabled_no_policy` jako INFO dla 46 tabel. Sam w sobie ten sygnał
nic nie mówi o ryzyku — rozstrzyga dopiero to, kto ma `GRANT` na tabelę.

Sprawdziłem komplet uprawnień tabelowych dla ról `anon`, `authenticated` i `PUBLIC`
w trzech schematach. **Żadna z 46 tabel bez polityk nie występuje w wyniku.** Wszystkie mają ACL
`postgres=arwdDxtm/postgres` (albo `null`, czyli uprawnienia domyślne właściciela).

Uprawnienia dla `authenticated` ma 30 tabel i widoków w `public` — i **każda z nich ma polityki
RLS**: `candidates`, `candidate_documents`, `applications`, `screening_*`, `recruitment_*`,
`behavior_*`, `exercise_*`, `companies`, `company_members`, `positions`, `recruitments`.
To są te, w których faktycznie leżą CV i dane kandydatów, i tam RLS działa.

**Konsekwencja:** dla tabel z tej listy dopisanie polityki niczego nie zmieni dopóki nie ma
`GRANT`-u — polityka bez uprawnienia jest martwa. Właściwym zabezpieczeniem jest utrzymanie braku
`GRANT`-u, a nie dopisywanie polityk. Rekomendacje w sekcji 3 idą w tę stronę.

---

## 2. Tabele bez polityk, które zawierają dane osobowe

Z 46 tabel dane osobowe (lub powiązania z nimi) trzyma 13 — 6 w sekcji 2a i 7 w sekcji 2b
(dwa wiersze zbiorcze w 2b obejmują po dwie tabele: `sales_pipeline` + `sales_pipeline_events`
oraz `sc19_trial_nips` + `sc19_trial_approvals`; `private.cv_bulk_batches` jest wliczona, choć
sama nie ma PII wprost). Dzielę je na te, które dotyczą **kandydatów**, i te, które
dotyczą **klientów i leadów** — zadanie pytało o kandydatów, ale reszta też jest danymi osobowymi
i nie ma sensu jej pomijać.

### 2a. Dane kandydatów

| Tabela | Co trzyma | Funkcje SD dla `authenticated` | Osiągalna dla `anon`? |
|---|---|---|---|
| `private.cv_bulk_items` | `file_name` (zwykle nazwisko kandydata w nazwie pliku), `candidate_id`, `application_id`, `name_detected` | 7 | nie |
| `private.application_preselection_groups` | `application_id`, `company_id`, `recruitment_id`, `raw_score`, `coverage` | 3 | nie |
| `private.application_preselection_group_events` | `application_id`, `actor_id`, `note` (tekst rekrutera o kandydacie) | 2 | nie |
| `private.retired_candidate_ids` | `candidate_id`, `company_id` — identyfikatory po usunięciu, wraz z firmą, generacją i terminem retencji | 1 | nie |
| `private.candidate_retention_policies` | `rules` (polityka retencji danych kandydatów), `approved_by` | 5 | nie |
| `private.cv_bulk_batches` | powiązania partii z firmą i rekrutacją, bez PII wprost | 7 | **tak** (`cv_bulk_finish_notification`) |

**Czego tam nie ma:** zredagowana treść CV leży w `public.candidate_documents`, a wyniki analizy
w `public.screening_*`. Obie grupy mają polityki RLS i to one są właściwą granicą dla treści CV.

### 2b. Dane klientów i leadów

| Tabela | Co trzyma | Funkcje SD dla `authenticated` | Osiągalna dla `anon`? |
|---|---|---|---|
| `public.sales_leads` | `first_name`, `company_name`, `email`, `phone`, `needs` | 7 | **tak** (`submit_sales_lead`, `claim_sales_mail`) |
| `checkout.orders` | `customer_name`, `customer_email`, `customer_phone`, `nip` | 4 | **tak** (4 funkcje `checkout_*`) |
| `private.sales_pipeline`, `private.sales_pipeline_events` | `note`, `next_contact_on` — notatki handlowe o leadzie | 2 | nie |
| `private.sales_mail_outbox` | kolejka maili do leadów | 2 | **tak** (`claim_sales_mail`, `finish_sales_mail`) |
| `private.sc19_trial_nips`, `private.sc19_trial_approvals` | `nip` (dla jednoosobowej działalności to dana osobowa) | 2–3 | nie |

---

## 3. Propozycje polityk

Dla każdej tabeli z sekcji 2 podaję propozycję. **Żadnej nie zastosowałem** — to materiał
do decyzji i do osobnego zadania L3 (RLS/grants to automatyczna eskalacja do L3 wg `AGENTS.md`).

### Wariant domyślny dla wszystkich tabel w `private` i `checkout`

Te schematy z założenia nie są wystawiane przez PostgREST. Zamiast polityk proponuję **utrwalić
to, co już faktycznie obowiązuje**, żeby przyszła migracja nie otworzyła ich przypadkiem:

```sql
-- PROPOZYCJA, nie zastosowana.
revoke all on all tables in schema private from anon, authenticated;
alter default privileges in schema private revoke all on tables from anon, authenticated;
-- to samo dla schematu checkout
```

#### Dlaczego NIE proponuję tu `force row level security`

W pierwszej wersji tego dokumentu napisałem, że warto dołożyć `force row level security`.
**Wycofuję to** — przy obecnej architekturze ta opcja nie daje ochrony, o którą chodzi, i może
wywrócić działającą aplikację. Powód jest w tym, względem jakiej roli Postgres dopasowuje polityki:

- Wszystkie funkcje `SECURITY DEFINER` w tym projekcie należą do `postgres`, więc **wykonują się
  jako `postgres`**, nie jako `authenticated`.
- Bez `force` właściciel tabeli omija RLS — i właśnie dlatego te funkcje dziś w ogóle czytają
  te tabele.
- Z `force` właściciel przestaje omijać RLS, ale polityki napisane `to authenticated` **nie
  dotyczą `postgres`**. Efekt: funkcje przestają działać, a polityki nie zaczynają nikogo chronić.
- Jest też druga gałąź: na Supabase rola `postgres` ma atrybut `BYPASSRLS`, którego `force`
  nie ogranicza — `force` dotyczy tylko zwolnienia właściciela tabeli, nie atrybutu roli. Jeśli
  funkcje działają jako `postgres` z `BYPASSRLS`, `force` nie zmienia dla nich niczego.

Żeby `force` miało sens, trzeba by albo dopisać równoległe polityki `to postgres`
(co sprowadza się do „pozwól właścicielowi na wszystko", czyli nic nie zmienia), albo przenieść
funkcje na osobną rolę właściciela i objąć ją politykami. To przebudowa modelu dostępu, nie
jednowierszowa migracja — i nie jest potrzebna, dopóki te tabele nie mają żadnego `GRANT`-u
dla `anon` i `authenticated`.

**Wniosek: realną granicą jest tu brak `GRANT`-u, nie RLS.** Polityki poniżej proponuję jako
drugą warstwę na wypadek, gdyby ktoś kiedyś taki `GRANT` dodał — same z siebie, bez `GRANT`-u,
są martwe, i to jest w porządku. Dlatego są to polityki **tylko do odczytu**: mają ograniczać
ewentualny przyszły odczyt przez klienta, a nie otwierać zapis.

### `private.cv_bulk_items`, `private.cv_bulk_batches`

Dostęp ma mieć tylko członek firmy będącej właścicielem partii. Helper `private.has_company_access`
już istnieje i jest używany przez `private.cv_bulk_item_for_write`.

```sql
-- PROPOZYCJA, nie zastosowana. Tylko odczyt.
create policy cv_bulk_items_company_read on private.cv_bulk_items
  for select to authenticated
  using (private.has_company_access(company_id)
         and (candidate_id is null
              or not private.erasure_candidate_frozen(candidate_id)));
```

Warunek `erasure_candidate_frozen` odwzorowuje filtr z `public.cv_bulk_batch_status`, które
ukrywa wiersze kandydatów zamrożonych przez procedurę usuwania danych (oraz wszystkich
kandydatów, gdy trwa izolacja odtworzeniowa). Bez niego druga warstwa odsłaniałaby to, co
obecne RPC świadomie chowa.

Uwaga wykonawcza, stan faktyczny (sprawdzony w migracjach i w katalogu Preview):
`private.erasure_candidate_frozen(uuid)` jest już `security definer` i już zwraca boolean, ale
`EXECUTE` jest na niej jawnie odebrane rolom `public`, `anon` i `authenticated`
(`20261010194230_candidate_erasure_guards.sql:1266`) i żadna późniejsza migracja go nie nadaje
ponownie — `authenticated` dostał tam `EXECUTE` tylko na `erasure_row_visible` i
`candidate_workflow_visible`. Wywołanie funkcji z polityki sprawdza `EXECUTE` roli wołającego
(`security definer` zmienia, jako kto funkcja *działa*, nie zastępuje prawa jej wywołania). Warunkiem
działania tej polityki jest więc **nadanie `EXECUTE` roli `authenticated`**, a to samo jest decyzją
L3. Bez tego każdy odczyt przez tę politykę skończy się `permission denied for function` —
fail-closed, więc bezpiecznie, ale polityka nie zadziała.

`cv_bulk_batches` nie ma kolumny kandydata, więc tam wystarcza `has_company_access(company_id)`,
wyłącznie `for select`. Widoczność wierszy kandydatów rozstrzyga się na poziomie `cv_bulk_items`.

**Świadomie nie proponuję polityki zapisu.** W pierwszej wersji miałem tu `for all` — to był błąd.
Gdyby kiedyś doszedł `GRANT` na zapis, taka polityka pozwoliłaby członkowi firmy wstawiać,
zmieniać i kasować wiersze `cv_bulk_items` **z pominięciem RPC**, a to one pilnują stanu slotów
i kredytów, powiązań z kandydatem oraz blokad usuwania (`private.cv_bulk_item_for_write`,
`private.cv_bulk_release_slot`, `private.erasure_lock_candidate`). Bezpośredni CRUD rozjechałby
stan partii. Zapis ma zostać wyłącznie za funkcjami.

### `private.application_preselection_groups`, `private.application_preselection_group_events`

Obie mają `company_id`, więc ten sam wzorzec, z tym samym zabezpieczeniem przed zamrożonymi
kandydatami co w `cv_bulk_items` (tak jak `get_preselection_groups` i
`get_preselection_group_history`, które pomijają zamrożonych). Te polityki wołają ten sam helper
`private.erasure_candidate_frozen`, więc dotyczy ich ta sama uwaga: `EXECUTE` jest dziś odebrane
`authenticated` i trzeba je nadać (decyzja L3), inaczej polityka skończy się
`permission denied for function` (fail-closed):

```sql
-- PROPOZYCJA, nie zastosowana.
create policy preselection_groups_company on private.application_preselection_groups
  for select to authenticated
  using (private.has_company_access(company_id)
         and exists (select 1 from public.applications a
                     where a.id = application_id
                       and not private.erasure_candidate_frozen(a.candidate_id)));
```

Dla tabeli zdarzeń `application_preselection_group_events` identyczny warunek i **tylko
`select`** — wpisy powstają wyłącznie przez `public.move_preselection_group` i mają zostać
append-only.

### `private.candidate_retention_policies`

Dziś gate to `private.erasure_owner(tenant)`, czyli **wyłącznie właściciel firmy**, nie każdy
członek. Polityka musi odwzorować dokładnie to, inaczej poszerzy dostęp:

```sql
-- PROPOZYCJA, nie zastosowana.
create policy retention_policies_owner on private.candidate_retention_policies
  for select to authenticated
  using (private.erasure_owner_visible(company_id));
```

`private.erasure_owner_visible` to **nowy** pomocnik (boolean, `SECURITY DEFINER`), który ma
odwzorować `private.erasure_owner` bez rzucania wyjątku: właściciel firmy
(`companies.owner_id = auth.uid()`) **oraz** brak izolacji odtworzeniowej
(`private.erasure_execution_config.restore_isolated`). Sam predykat `owner_id` nie wystarcza,
bo `erasure_owner` zwraca `PT409` w czasie izolacji, a `get_candidate_retention_policy` przez
niego przechodzi. Tabela konfiguracji jest w `private` bez uprawnień dla klienta, dlatego
sprawdzenie musi siedzieć w funkcji `SECURITY DEFINER`, a nie bezpośrednio w polityce.
Równie dobra, i prostsza, jest druga opcja: nie dawać klientowi bezpośredniego `GRANT`-u
na tę tabelę i zostawić odczyt wyłącznie przez `get_candidate_retention_policy`.

### `private.retired_candidate_ids`

Tabela **ma** kolumnę `company_id` (`not null`, razem z `generation`, `recovery_event_id`
i `retain_until`; definicja w `20261010205030_erasure_purge_graph.sql`), więc technicznie dałoby
się ją podzielić po firmach. Polityki dla `authenticated` mimo to **nie proponuję**, z innego
powodu niż poprzednio: to wewnętrzny rejestr procedury usuwania danych, czytany przez
`private.erasure_normal_row_guard` i walidację purge, a żaden ekran ani RPC nie czyta go w
imieniu użytkownika. Polityka tenantowa udostępniałaby firmie listę identyfikatorów
usuniętych kandydatów bez żadnej potrzeby biznesowej, a przy okazji ominęłaby warunki
bezpieczeństwa tej procedury (np. izolację odtworzeniową). Migracja już robi jawny
`revoke all` z tej tabeli dla `public`, `anon` i `authenticated` oraz włącza RLS.
Rekomendacja: zostawić bez polityki i bez `GRANT`, a ochronę opisać w komentarzu do tabeli,
żeby kolejny audyt nie czytał tego jako luki.

Uzgodnienie z tabelą w 2a, gdzie przy tej tabeli stoi „1 funkcja SD dla `authenticated`":
to `private.erasure_normal_row_guard`, która ma `grant execute ... to authenticated`
(`20261010205030_erasure_purge_graph.sql:545`) i czyta tę tabelę (`:178`). To jednak pomocnik
triggera, wywoływany w kontekście zapisu użytkownika, a nie ekran ani RPC czytające dane dla
użytkownika: nie zwraca wierszy, tylko rzuca `PT409` (`Candidate identity unavailable`), gdy
identyfikator kandydata jest na liście usuniętych albo trwa izolacja odtworzeniowa.

### `public.sales_leads`

To jedyna tabela z sekcji 2 leżąca w `public`, czyli w schemacie wystawianym przez PostgREST.
Dziś nie ma `GRANT`-u i to ją chroni, ale margines jest najcieńszy — jeden `grant select` w
przyszłej migracji wystawia bazę leadów z mailami i telefonami.

```sql
-- PROPOZYCJA, nie zastosowana.
create policy sales_leads_operator_only on public.sales_leads
  for select to authenticated
  using (private.is_platform_operator((select auth.uid())));
```

Odpowiada to gate'owi, który mają już `list_sales_leads`, `list_sales_leads_inbox`,
`list_sales_pipeline`, `save_sales_pipeline`, `close_sales_lead` i `sales_pipeline_history`.
Wstawianie zostaje wyłącznie przez `submit_sales_lead` (podpis HMAC) — **bez** polityki `insert`.

### `private.sales_pipeline`, `private.sales_pipeline_events`, `private.sales_mail_outbox`

Ten sam gate operatora co wyżej, `select` dla operatora, zapis tylko przez istniejące funkcje.

### `checkout.orders`

**Dryf schematu:** w `supabase/migrations/` nie ma żadnego pliku tworzącego schemat `checkout`,
tabelę `checkout.orders` ani funkcje `checkout_*` (sprawdzone wyszukiwaniem w całym repozytorium —
jedyne trafienie to ten dokument). Wszystkie twierdzenia o `checkout` w tym dokumencie pochodzą
wyłącznie z odczytu katalogu bazy Preview, nie z migracji. Sam dryf schematu (stan bazy bez
odpowiednika w repozytorium) to osobne zadanie.

Dostęp wyłącznie przez cztery funkcje `checkout_*`, każda weryfikuje `request_signature` i nie
używa `auth.uid()` — to ścieżka maszynowa (webhook Przelewy24), nie użytkownik. Polityki dla
`authenticated` **nie proponuję**; proponuję natomiast jawny `revoke` jak w wariancie domyślnym,
bo tabela zawiera komplet danych kontaktowych i NIP kupującego.

### `private.sc19_trial_nips`, `private.sc19_trial_approvals`

Gate operatora (`private.sc19_require_operator`). Polityka `select` dla operatora, analogicznie do
`sales_leads`.

---

## 4. Funkcje `SECURITY DEFINER` dostępne dla `authenticated`, które dotykają tych tabel

Poniżej 43 funkcje: operator 11 + firma 14 + właściciel 6 + HMAC 9 + administracyjne 2 + bez
gate'u 1. Z nich **42 mają `EXECUTE` dla `authenticated`**; 43. to `cv_bulk_worker_pump`, która
ma `EXECUTE` wyłącznie dla `anon` (`20261101130000_cv_bulk_intake.sql:753`; `authenticated` ma
ją jawnie odebraną) i jest tu wyliczona jako ścieżka maszynowa. W pierwszej wersji tego dokumentu
stało „45 funkcji" — tej liczby nie da się odtworzyć ani z migracji, ani z katalogu Preview
(porównałem wszystkie funkcje `SECURITY DEFINER` z `EXECUTE` dla `authenticated`; żadna dodatkowa
nie czyta tabel z sekcji 2 — `find_sales_companies` czyta tylko `companies`,
`sc19_operator_grant_paid` tabele salda i dziennika kredytów, `get_retention_suggestions` tabele
sugestii retencji), więc poprawiłem ją na faktyczną. Każdą z tych funkcji sprawdziłem pod kątem
faktycznej kontroli uprawnień — nie po nazwie, tylko czytając ciało funkcji i ciała helperów,
które wołają.

### Gate operatora (`private.sc19_require_operator` / `private.is_platform_operator`)

`cv_ai_usage_stats`, `sc19_operator_companies`, `sc19_operator_approve_trial`,
`sc19_operator_package_policy`, `sc19_operator_set_package_policy`, `list_sales_leads`,
`list_sales_leads_inbox`, `list_sales_pipeline`, `save_sales_pipeline`, `close_sales_lead`,
`sales_pipeline_history`.

`private.sc19_require_operator()` sprawdza `auth.uid()` i członkostwo w `platform_operators`,
rzucając `42501`. Bez zastrzeżeń.

### Gate firmy (`private.has_company_access`)

`cv_bulk_create_batch`, `cv_bulk_batch_status`, `cv_bulk_recruitment_batches`,
`cv_bulk_close_upload`, `cv_bulk_pump`, `cv_bulk_register_item`, `cv_bulk_fail_item`,
`get_preselection_groups`, `get_preselection_group_history`, `move_preselection_group`,
`sc19_claim_trial`, `sc19_get_balance`, `add_recruitment_shortlist_entry`,
`approve_candidate_communication`.

Warto odnotować dwie, które przy pobieżnym czytaniu wyglądają na niezabezpieczone:

- **`cv_bulk_fail_item`** — w swoim ciele nie ma żadnego sprawdzenia. Gate jest w
  `private.cv_bulk_item_for_write(target_item)`, które wymaga `auth.uid()` i
  `private.has_company_access(company, true)`, i rzuca `PT404` dla cudzej partii. Zabezpieczona.
- **`approve_candidate_communication`** — gate w `private.contact_lock_candidate`, które sprawdza
  `has_company_access` dwukrotnie (odczyt i zapis) plus rolę `recruiter` albo własność firmy.
  Zabezpieczona, i to mocniej niż pozostałe.

### Gate właściciela firmy (`private.erasure_owner`)

`configure_candidate_retention_policy`, `get_candidate_retention_policy`, `get_retention_schedule`,
`configure_retention_schedule`, `revoke_retention_schedule`, `preview_candidate_erasure`.

`private.erasure_owner(tenant)` wymaga `auth.uid()` i `companies.owner_id = auth.uid()` — węższe
niż członkostwo w firmie. Dodatkowo blokuje się, gdy trwa izolacja odtworzeniowa (`PT409`).

### Gate podpisu HMAC (ścieżki maszynowe)

`checkout_create_order`, `checkout_read_order`, `checkout_update_order`, `checkout_pending_orders`,
`claim_sales_mail`, `finish_sales_mail`, `cv_bulk_worker_pump`, `submit_sales_lead`
(osiem funkcji) oraz `cv_bulk_finish_notification` (dziewiąta, z dwiema ścieżkami — niżej).

(Z dziewięciu `cv_bulk_worker_pump` jest dostępna tylko dla `anon`, pozostałe osiem także dla
`authenticated`.) Osiem z nich nie ma ścieżki użytkownika — autoryzacja opiera się na `request_signature`
i `issued_at`. (`submit_sales_lead` odczytuje `auth.uid()`, ale tylko po to, by włączyć go do
podpisywanego ładunku i zapisać przy leadzie; to nie jest bramka dostępu.) To świadomy wzorzec
dla workerów i webhooków, ale oznacza, że **bezpieczeństwo tych ośmiu funkcji sprowadza się do
tajności sekretu HMAC i do poprawnej walidacji okna czasowego**.

**`cv_bulk_finish_notification` ma dwie ścieżki.** Gdy wywołanie niesie `request_signature`,
sprawdzany jest podpis HMAC (worker powiadomień). Gdy podpisu brak, funkcja wymaga
`auth.uid()` oraz `private.has_company_access(company_id, true)` (członek firmy z prawem
zapisu), a w razie braku rzuca `PT404`. Jej ryzyko to więc suma obu ścieżek: tajność sekretu
HMAC **i** poprawność bramki firmy. Dodatkowo funkcja jest dostępna dla `anon` (jedynie
ścieżka HMAC może przejść), co zgadza się z tabelą w sekcji 2a.

Nie audytowałem tu siły samej weryfikacji podpisu — to osobne zadanie, patrz sekcja 5.

### Uprawnienia administracyjne

`grant_platform_operator`, `revoke_platform_operator` — wymagają, żeby wołający sam był aktywnym
operatorem (`for update` na własnym wierszu). `revoke` dodatkowo nie pozwala usunąć ostatniego
operatora. Eskalacja uprawnień przez te funkcje nie jest możliwa dla zwykłego użytkownika.

### Jedna bez żadnego gate'u — i tak ma być

`public.sc19_package_sizes()` — zwraca wyłącznie `plan` i `credits` z `private.sc19_package_policy`
(czyli „FREE = 5, PRESELEKCJA = 60"). Dostępna dla `anon`, bo publiczna strona z niej czyta.
Brak danych osobowych, brak parametrów. Bez zastrzeżeń.

---

## 5. Trzy rzeczy do domknięcia (propozycje, nie zmiany)

1. **`public.sales_leads` to najcieńszy margines.** Leży w schemacie wystawianym przez PostgREST,
   trzyma maile i telefony, a chroni ją wyłącznie brak `GRANT`-u. Proponuję politykę operatora
   z sekcji 3 **plus** test w CI, który sprawdza, że `anon` i `authenticated` nie mają uprawnień
   do żadnej tabeli w `public` bez polityk. Repo ma już wzorzec: `tests/data-api-grants.test.mjs`.

2. **20 tabel bez polityk nie występuje w ciele żadnej funkcji `SECURITY DEFINER`** dostępnej
   dla `authenticated` (12 pozycji poniżej; `erasure_inventory_baseline` wraz z `_r2`–`_r9` to
   9 tabel, więc 11 + 9 = 20; sprawdzone bezpośrednim przeszukaniem ciał funkcji w katalogu
   Preview, bez rozwijania wywołań pomocników — trzy z nich, `checkout.settings`,
   `private.cv_bulk_worker_nonces` i `private.sales_mail_settings`, czytają pomocniki weryfikacji
   podpisu wołane z funkcji HMAC z sekcji 4): `checkout.settings`, `private.cv_bulk_worker_nonces`,
   `private.erasure_inventory_baseline` i wersje `_r2`–`_r9`, `private.erasure_restore_checkpoint`,
   `private.erasure_verified_ledger_events`, `private.retention_authorizations`,
   `private.sales_mail_settings`, `private.sc19_analysis_spend`, `private.sc19_payment_grants`,
   `private.sc19_payment_offers`, `private.sc19_payment_orders`, `private.sc19_payment_requests`.
   To dobra wiadomość z punktu widzenia bezpieczeństwa, ale `erasure_inventory_baseline_r2`–`_r9`
   wyglądają na pozostałości po kolejnych rewizjach inwentarza usuwania (używana jest `_r10`).
   Proponuję osobne zadanie porządkowe: potwierdzić, które rewizje są martwe, i usunąć je migracją.
   **Nie usuwałem niczego.**

3. **Osiem funkcji opiera autoryzację wyłącznie na HMAC, a dziewiąta
   (`cv_bulk_finish_notification`) na HMAC albo na bramce firmy.** Dotykają `checkout.orders`
   (dane kontaktowe kupującego), `public.sales_leads` i kolejki powiadomień partii CV. Proponuję osobny audyt L3 tej ścieżki:
   skąd pochodzi sekret, czy okno `issued_at` jest wąskie, czy podpis obejmuje wszystkie
   parametry i czy porównanie jest odporne na timing. To wykracza poza pytanie o RLS, ale jest
   dziś realną granicą bezpieczeństwa dla tych dwóch tabel.

---

## Czego ten triage nie obejmuje

- Nie sprawdzałem produkcji (`wsvjawuikxfzjyivxgsu`). Zgodnie z `AGENTS.md` produkcja jest
  dostępna dla sesji agentowych tylko w trybie `read_only`; ten dokument dotyczy wyłącznie Preview.
  **Schematy mogą się różnić** — wnioski nie przenoszą się automatycznie.
- Nie oceniałem polityk na 30 tabelach, które je mają. Pytanie dotyczyło tabel bez polityk;
  jakość istniejących polityk to osobne zadanie.
- Nie oceniałem siły weryfikacji HMAC (punkt 3 wyżej).
- `auth_leaked_password_protection` (WARN z Advisora) to ustawienie projektu Supabase, nie RLS —
  odnotowuję, bo wyszło przy okazji; włączenie jest decyzją właściciela, bo dotyczy konfiguracji
  projektu.
