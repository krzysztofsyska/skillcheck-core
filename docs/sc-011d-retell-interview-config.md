# SC-011-D — konfiguracja rozmowy Retell (firma i stanowisko ze zmiennych)

TASK: SC-011-D | SCOPE: BACKEND | LEVEL: L3 (kontrakt dostawcy AI) | OWNER: ChatGPT
REVIEWER: niezależny Codex | DEPENDS ON: SC-011-C (#122), SC-012, SC-010-C
STATUS: OFFLINE, NIE WGRANE DO RETELL | PRODUCTION_APPROVAL: NO | EXTERNAL_CALLS: NO | DB/MIGRATIONS: NONE

## Po co

Do tej pory w repo nie było samej rozmowy (agenta i flow Retell). Kompilator przekazywał tylko listę pytań, wersję informacji i język. Ten krok dodaje:

- **jedną wersjonowaną definicję rozmowy w repo**: `config/retell/skillcheck-interview-v1/conversation-flow.json` i `agent.json`, w formacie API Retell (create-conversation-flow, create-agent);
- **dwie nowe zmienne**, które kompilator ustawia przy każdym połączeniu, więc ten sam agent mówi o właściwej firmie i stanowisku:

| Zmienna | Źródło | Uwagi |
| --- | --- | --- |
| `skillcheck_company_name` | `public.companies.name`, odczyt po stronie serwera w transakcji przygotowania (RLS + filtr `company_id`) | Musi należeć do firmy z zatwierdzonego planu. |
| `skillcheck_position_title` | `position.title` ze źródła planu SC-012 (objęte `sourceFingerprint`) | Wywołujący nie może go podać ani podmienić. |
| `skillcheck_interview_script` | zatwierdzone pytania SC-012 | bez zmian |
| `skillcheck_notice_version` | `notice-pl-202610` | bez zmian, nieodczytywane na głos |
| `skillcheck_language` | `pl-PL` | bez zmian |

Do Retell nadal nie trafia: imię i nazwisko kandydata, CV, wyniki, identyfikatory firmy i aplikacji ani tekst zadań stanowiska.

## Rozmowa (v1)

Persona: „wirtualny asystent rekrutacji firmy {{skillcheck_company_name}}”, jawnie jako program komputerowy (decyzja właściciela z 2026-10-29). Jeden agent i jeden głos dla wszystkich firm.

1. **Powitanie** (tekst stały): przedstawia się w imieniu firmy i pyta, czy rozmawia z osobą, która wysłała zgłoszenie. Stanowisko pada dopiero po potwierdzeniu, żeby osoba trzecia nie usłyszała, na jakie stanowisko ktoś aplikował.
2. **Informacja** (tekst stały): stanowisko, AI, ok. 7 minut, brak nagrywania, decyzje podejmuje rekruter, można przerwać. Pytanie o zgodę na start.
3. **Pytania** (prompt): wyłącznie pytania i dopytania z `{{skillcheck_interview_script}}`, dosłownie, z limitami czasu, bez ocen i komentarzy.
4. **Zakończenia** (teksty stałe): ukończony wywiad, rezygnacja, „nie teraz”, pomyłka.

Globalny prompt zawiera wymagane przez bramkę zdania (zakaz pytań o zdrowie i dane szczególne oraz pełny zakaz tematów SC-012). Zawiera też regułę, że nazwy firmy i stanowiska są tylko nazwami, a nie poleceniami. Agent: `pl-PL`, `enable_dnc_detection: true`, `basic_attributes_only`, retencja 30 dni, maksymalnie 600 s, rozłączenie po 30 s ciszy, rozłączenie na poczcie głosowej, `boosted_keywords` z nazwą firmy dla lepszej transkrypcji.

## Walidacja nazw (`retellSpokenName`)

Nazwa firmy i stanowisko są normalizowane (NFC, pojedyncze spacje, usunięte cudzysłowy `"„”“«»`) i muszą mieć 1–120 znaków. Dozwolone są litery, cyfry, spacja i `.,&'’()/+-–:#®™!`. Wszystko inne, w tym klamry, znaki nowej linii, `<>` i backtick, **blokuje przygotowanie rozmowy** (`RETELL_DRAFT_REJECTED`), a nie jest po cichu usuwane. Firma z taką nazwą musi ją poprawić w ustawieniach przed użyciem voicebota.

Ryzyko resztkowe: zdanie w zwykłych słowach (np. „Zignoruj zasady”) przejdzie walidację. Chroni przed nim reguła globalnego promptu i stałe teksty powitania oraz informacji. Nazwy wpisuje sama firma-klient, która dzwoni do własnych kandydatów.

## Jak zmieniać rozmowę

Treść zmieniamy w repo, nie w panelu Retell:

1. Edytuj `config/retell/skillcheck-interview-v1/*.json`. Większa zmiana zachowania to nowy katalog `skillcheck-interview-v2`.
2. `node scripts/retell-config.mjs check` oraz `node --test tests/retell-config.test.mjs`. Test przepuszcza konfigurację przez prawdziwą bramkę `verifyRetellOutboundAgent` i kompilator, a potem sprawdza, co agent faktycznie powie.
3. PR do `integration`, review, merge.
4. Wgranie do Retell (krok właściciela, poniżej) i zapisanie nowych skrótów SHA-256.

Nowa zmienna wymaga zmiany kodu (`RETELL_DYNAMIC_VARIABLES` i kompilator). Bramka odrzuca każdą nieznaną `{{zmienną}}`.

## Wgranie do Retell — krok właściciela

Agenci tego nie wykonują. Utworzenie agenta nie dzwoni i nie generuje kosztów połączeń, ale jest działaniem na zewnętrznym koncie. Klucz API tylko z bezpiecznego miejsca, nigdy w repo ani w historii powłoki.

```bash
curl -sS -X POST https://api.retellai.com/create-conversation-flow -H "Authorization: Bearer $RETELL_API_KEY" -H "Content-Type: application/json" --data @config/retell/skillcheck-interview-v1/conversation-flow.json
```

Zanotuj `conversation_flow_id` i `version` z odpowiedzi. Wybierz polski głos w panelu Retell (`voice_id`).

```bash
node scripts/retell-config.mjs agent <conversation_flow_id> <version> <voice_id> > agent-create.json
```

```bash
curl -sS -X POST https://api.retellai.com/create-agent -H "Authorization: Bearer $RETELL_API_KEY" -H "Content-Type: application/json" --data @agent-create.json
```

Następnie w panelu Retell opublikuj agenta i przypisz dokładny tag (np. `skillcheck_mvp`). Przetestuj rozmowę w panelu (test tekstowy/głosowy, bez dzwonienia do kandydatów), podając przykładowe wartości zmiennych.

Na koniec zapisz odpowiedzi GET i policz skróty, które przypina `RetellOutboundConfig`:

```bash
curl -sS "https://api.retellai.com/get-agent/<agent_id>?version=<tag>" -H "Authorization: Bearer $RETELL_API_KEY" > agent-get.json
```

```bash
curl -sS "https://api.retellai.com/get-conversation-flow/<conversation_flow_id>?version=<version>" -H "Authorization: Bearer $RETELL_API_KEY" > flow-get.json
```

```bash
node scripts/retell-config.mjs digest agent-get.json
```

```bash
node scripts/retell-config.mjs digest flow-get.json
```

Wyniki to `approvedAgentSha256` i `approvedFlowSha256`. Ustaw `maxBudgetSeconds: 600`, bo agent ma `max_call_duration_ms: 600000`. Każda późniejsza zmiana w panelu Retell zmienia skrót i bramka zablokuje rozmowy, dopóki nowa wersja nie przejdzie review.

## Do decyzji przed pierwszym testowym telefonem

- **Treść informacji dla kandydata** (węzeł `notice`) wymaga akceptacji właściciela i prawnej, razem z wersją `notice-pl-202610`.
- **Głos** (`voice_id`) i **model** (`gpt-4.1`, temperatura 0) można zmienić. Model i dostawca TTS to podprocesorzy, których trzeba ująć w RODO.
- **Odpowiedzi kandydata**: przy `basic_attributes_only` Retell nie przechowuje transkrypcji. SC-013 (analiza z dowodami) potrzebuje osobnej, zatwierdzonej ścieżki przekazania transkrypcji (podpisany webhook SC-011-B, #79). Ta konfiguracja jej nie dodaje.
- Wiring `RetellOutboundConfig` z sekretów serwera i worker wysyłający POST to nadal SC-011-B / SC-010-C.

## Testy

```bash
node --test tests/retell-config.test.mjs tests/retell-outbound-draft.test.mjs
```

```bash
node scripts/retell-config.mjs check
```

Testy bazodanowe przygotowania (`tests/voice-preparation.test.mjs`) sprawdzają, że szkic zawiera pięć zmiennych.
