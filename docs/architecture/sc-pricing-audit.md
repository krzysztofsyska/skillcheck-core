# SC-PRICING-001 — audyt integracji i ryzyk
**Stan:** 2026-10-20, `integration` w punkcie startowym `a3612b5fe8eac072b0cf7f0c67c6c672fede80b7`. To audyt kodu i informacji z GitHub, nie środowiska Production.

## Zweryfikowane elementy do ponownego wykorzystania

| Właściciel / zasób | Dowód | Reuse / ograniczenie |
| --- | --- | --- |
| Instrukcje agentów | `AGENTS.md`, `docs/TASK_TEMPLATE.md`, `docs/DEFINITION_OF_DONE.md` | L3; task branch -> integration; independent review on current HEAD, no main |
| SC-019 kredyty | scalony PR #92, `docs/prototypes/sc-019-mvp-credits.sql` | Reuse istniejącego ledger/debit/reversal. **Nie** kopiować w nowym pricing. Prototyp nie jest wdrożoną migracją. |
| Polityka kredytów | otwarty Draft PR #115 | Dotyka `app/components/marketing/package-comparison.tsx`, `home-page.tsx`, billing i `lib/sc19-package-sizes.ts`; wymaga synchronizacji przed marketing PR. Nie deklarować merged/gotowości. |
| Zamówienia i checkout | otwarty Draft PR #129, `lib/sc19-payments.ts`, `docs/prototypes/sc19-payment-storage.sql` w branch PR | Idempotent request + immutable order economics/terms/provider-verified payment; integration dopiero po gotowości upstream. Runtime default DISABLED. |
| Publiczna strona | `app/components/marketing/{package-comparison,content,home-page}.tsx/ts`, `app/preselekcja/page.tsx` | Copy i CTA do ponownego wykorzystania; porównanie zawiera **ilustracyjne** 899/1799 zł, nie zatwierdzone ceny. Nie kopiować do aktywnego cennika. |
| Panel operatora | `app/operator/sales/access.ts`, `app/operator/sales/page.tsx` | `platform_operator_status` daje dostęp do procesu sprzedaży, **nie** wystarcza jako uprawnienie pricing_edit/pricing_publish. |
| Firma i sesje | `lib/company-access.ts`, `lib/supabase/server.ts`, SC-019 | Wzorzec auth.getUser()/RLS oraz tenant; nie utożsamiać ownera firmy z globalnym właścicielem cenników. |
| Test runner | `package.json`, `.github/workflows/checks.yml` | Node test runner, typecheck/build, PostgreSQL16, Agent Gates. Nowe testy należy jawnie wpiąć w CI. |
| SC-005/SC-010 | issue #6/#11, SC-010 schema + erasure controls | Nie aktywować nieweryfikowanych capabilities; nowe tabele retention/erasure wymagają odrębnego przeglądu. |
| Sales release | PR #120 | DRAFT do main, poza zakresem; pricing nie może opóźniać startu FREE/PRESELEKCJA. |

## Znaleziony kalkulator v4
Biblioteka plików użytkownika zawiera `SkillCheck_kalkulator_klienta_podglad_v4.html` (611 linii), niezależny dokument HTML, **nie plik w bieżącym repozytorium**. Elementy do adaptacji w #145:
- cztery pakiety, przełączanie planu; szybkie 10/20/30 CV, 35–150 co 5;
- symulator czasu/kosztu rekrutera, porównanie z agencją oraz transparentne założenia i źródła;
- responsywna typografia, sekcje CTA, szczegóły założeń.
W HTML robocze ceny i wzór wzrostu wolumenu są **niesformalizowane**: nie są zaakceptowanym katalogiem ani contract do finalnej wyceny. Dodatki v4 jako „do indywidualnej wyceny” nie są automatycznie kupowalne. Wersję publiczną przepiąć na serwerowy silnik, nie kopiować JS liczącego cenę w przeglądarce.

## Stan elementów docelowych na integration
Brak `app/kalkulator`, `app/operator/pricing`, `lib/pricing` oraz relacyjnego katalogu `package_service`. Nie znaleziono wdrożonego systemu wersjonowanych cenników. Nie dowodzi to braku eksperymentów na odrębnych gałęziach; przed dotykaniem wspólnych plików sprawdzić bieżące PR ponownie.

## Kolizje i kolejność
- #138 (architektura): własny katalog dokumentacji, bez kolizji.
- #140 (pure quote engine): nowe `lib/pricing/` + test, może ruszyć po kontrakcie #138, nie dotyka #115/#129.
- #139 katalog DB: osobny izolowany prototyp; zgodność z SC-010 przed migracją; bez `supabase/migrations` bez zgody.
- #141 publikacja zależy od #139/#140; transakcja serializable/CAS.
- #142 API zależy od role/grants i publikacji; jawne permissions.
- #143/#144 UI tylko po API/quote contract.
- #145 calculator po publicznym opublikowanym catalog/quote.
- #146 marketing dopiero po zharmonizowaniu #115 i #145 (marketing dotyka tych samych plików).
- #147 adapter płatności zależy od #129 i SC-019 finalnego kontraktu; nie tworzyć drugiego payment path.
- #148 test E2E + release runbook po integracji.

## Punkty nieweryfikowane / wymagające później dowodów
1. Aktualne prod env/DB migrations/live API i capability availability — nie sprawdzane w ramach audytu kodu; zawsze oddzielna zgoda Production.
2. Rzeczywiste uprawnienie platform owner do cenników; nie używać `platform_operator_status` jako przepustki.
3. Finalne ceny, VAT dla konkretnych usług, warunki prawne, limity i rabaty — **brak zatwierdzenia**.
4. PR #115 i #129 nie spełniają jeszcze bramki merged do integration.
5. Pełne E2E v4 nie istnieje w Next.js; artefakt HTML jest tylko referencją UX.

## Kryterium zakończenia #138
Review dokumentu względem aktualnego repo, typecheck/build/CI lub jawny status NOT RUN; nie przypisywać PASS bez realnego run. Nie publikować katalogu ani nie modyfikować `main`.