# SC-PRICING-001 — wersjonowany kontrakt systemu oferty (v1)
**TASK:** SC-SALES-MODULAR-PRICING / #137 / #138. **LEVEL:** L3. **SCOPE:** FULLSTACK.
**Status:** propozycja do niezależnego review; nie jest zatwierdzoną ofertą handlową ani zgodą na migracje Production.

## Granice domeny
1. **Product catalog:** globalny/scope-specific `Package`, `Service`, `PackageService`, `CapabilityRegistry`. Znaczenie `service_code` stabilne; nazwy/opisy/taryfy wersjonowane. System nie zakłada zamkniętej listy dodatków w UI.
2. **Pricing:** czysta, deterministyczna serwerowa funkcja `quote(version, selections)`; żadnych odczytów tenant balance, payment provider ani kosztów z publicznego API. `pricing_method` jest typowaną enumeracją (bez JS/SQL od admina).
3. **Commercial publishing:** stany `DRAFT → VALIDATED → PUBLISHED → SUPERSEDED`, historia i transactionally switched active pointer. `ARCHIVED` tylko dla porzuconych draftów; immutable published snapshot.
4. **Private costs:** osobna domena/tabela, brak kluczy i pól kosztowych w `public` schema, endpointach, preview i serializowanych pakietach dla klienta.
5. **SC-019 bridge:** osobny adapter z immutably snapshotted `quote.versionId`, line items, PLN gross, terms; ledger/kredyty/płatności należą wyłącznie do SC-019.

## Typy danych i niezmienniki
```ts
type PackageCode = 'FREE' | 'PRESELEKCJA' | 'WERYFIKACJA' | 'ASSESSMENT_CENTER';
type CommercialStatus = 'hidden' | 'informational' | 'on_request' | 'purchasable';
type TechnicalStatus = 'planned' | 'prototype' | 'verified'; // verified != ready at runtime
type Unit = 'cv' | 'candidate' | 'interview' | 'test' | 'scenario' | 'minute' | 'hour' | 'item';
type PricingMethod = 'fixed' | 'per_unit' | 'volume_tier' | 'bundle';
type PriceVersionState = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED';
type MoneyMinor = number; // positive/zero SAFE INTEGER in PLN grosze, subject to strict bounds
type BasisPoints = number; // 0..10000 for VAT/discount; integer
interface Service {
  code: string; name: string; description: string; category: string; unit: Unit;
  min: number; max: number; step: number; capabilityCode: string | null;
  technicalStatus: TechnicalStatus; commercialStatus: CommercialStatus;
  dependencyCodes: string[]; exclusionCodes: string[]; sortOrder: number; visible: boolean;
}
interface PackageService {
  package: PackageCode; serviceCode: string; allowed: boolean; included: number;
  extraAllowed: boolean; max: number; visible: boolean;
  defaultPriceRuleId: string | null; overridePriceRuleId: string | null;
  autoPurchase: boolean; commercialStatus: CommercialStatus;
}
interface QuoteRequest {
  package: PackageCode; quantityCv: number; extras: { serviceCode: string; quantity: number }[];
  expectedVersionId: string; // anti-stale, never price input
}
```
Baza: `pricing_scope`, `price_versions`, `services`, `packages`, `package_services`, `price_rules`, `pricing_audit`, `active_price_pointer`, `private_pricing_costs`. Relacje i keys sklejone z immutable version ID; `service_code` unikatowy w zakresie wersji, `(version_id,package,service_code)` unikatowe; brak CAS po stronie klienta. Nie edytować danych historycznego zamówienia ani publikacji.

### Walidacja przed publish (po stronie DB i serwera)
- Jedna aktywna `(locale=pl-PL,currency=PLN,audience=public)` oferta. Zero aktywnej oferty to poprawny stan „brak cennika”.
- Każdy pakiet ma jawny status, bazową cenę lub `on_request`, limity; BUYABLE wymaga zatwierdzonej ceny, regulaminu, docelowego procesu technicznego, wdrożonych uprawnień i serwerowo potwierdzonej capability.
- Usługa może mieć wiele PackageService; konfiguracja WERYFIKACJA nie przenosi się automatycznie do AC; included per package ma pierwszeństwo. Podstawowa usługa wyceniana tylko raz.
- Sprawdzać `min <= max`, step, spójność unit/threshold, ilości z formularza, brak cykli dependencies, brak wzajemnych exclusions, zależności między usługami przypisanymi do tej samej oferty.
- Status `verified` zapisany przez admina nie jest wystarczającym potwierdzeniem `runtimeCapabilityReady`. Żadnej automatycznej sprzedaży `planned/prototype`.
- Zatwierdzony grosz/VAT/terms i spójne wersje dla całego snapshotu; brak roboczych cen z marketingu lub pliku v4 w seedach.

## Reguły finansowe (wersja algorytmu `pln-v1`)
- Wszystkie ceny **netto w całkowitych groszach**; wynik jest w PLN.
- Podstawowy wolumen CV oraz inne usługi liczone według **odrębnych**, walidowanych reguł; `extraQuantity = max(0, requested - included)`. Included ma 0 charge; wszystkie linie muszą wskazywać jawnie usługi/ilości.
- `fixed`: jednorazowa kwota (jeśli dana usługa jest wybrana ponad ilość wliczoną), `per_unit`: stała cena × dodatkowa ilość; `volume_tier`: jedna spójna polityka `graduated` albo `all_units` wskazana przez version; `bundle`: zatwierdzony zestaw z unikatowym przypisaniem składników, bez podwójnego pobrania.
- Rabat stosowany do dozwolonej podstawy netto, nie może dać wyniku ujemnego. Nie zaokrąglać ułamków liczbą float: operacje na **integer safe** z jawnym sprawdzeniem przepełnienia, procent w basis points, zaokrąglenie **half-up** przy finalizacji rabatu i VAT. Gross = discounted net + round(discounted net × VAT bps / 10000).
- Wycena odmawia gdy brak ceny, brak PUBLISHED dla klienta, nieobsługiwana reguła, niewłaściwa quantity/step, niespełnione prerequisites, nieaktywny dodatek, niespójne statusy lub `expectedVersionId` różni się od aktualnego.
- Cennik FREE może mieć 0 zł netto wyłącznie przy jawnie zatwierdzonym publicznym planie; nie interpretować braku ceny jako zera.

## API contracts
- `GET /api/pricing/catalog`: `{versionId,validUntil,packages:[{code,description,status,cvOptions,services:[{code,name,unit,qty,priceDisplay,status}]}]}`. Only published, cache invalidation on publish, no costs/cost markup/internal statuses/secrets/drafts.
- `POST /api/pricing/quote`: input strictly `QuoteRequest`; server-side selection, constraints & pricing; response `{versionId,quoteId,expiresAt,lines,netMinor,vatMinor,grossMinor,currency:'PLN',purchaseEligibility}`. Price/discount fields in browser input forbidden.
- `/api/operator/pricing/**`: authenticated owner, separate capabilities `pricing_edit` and `pricing_publish`. Editing never publishes; publishing requires server confirmation token bound to version+hash, audit actor/old/new, CAS and atomicity.
- `GET /api/operator/pricing/preview?versionId`: read draft as a **public projection**, never serialized with internal costs.
- Quote order integration (future #147): quote/version/terms must be validated and snapshotted atomically at checkout. Older displayed quotes -> retry/reconfirmation; provider totals compared against immutable SC-019 gross.

## Granice bezpieczeństwa
- Public/anon: published catalogue and public quote only, no edits, drafts, private costs. Owner: authenticated global platform role independent of `platform_operator_status`; revocation checked at DB write time. Tenant company owners **do not** inherit pricing management.
- PostgreSQL: explicit RLS/GRANT for every table/RPC, SECURITY DEFINER pinned `search_path`, strict auth role and row checks, idempotent publish key and actor audit. Race prevention via unique active scope + transactional lock + expected revision.
- Neither browser nor marketing link sets amountMinor, discount, pricing tier, version status, technical readiness or entitlement. Strict bounded inputs and reject unknown fields in API.
- No payment/live callbacks to activate feature; trust only SC-019 verified settlement. No production DB migrations in this task.

## UI behavior and fallback
- URL may select package, CV count, addon and attribution; unknown/addon incompatible with new package is cleared, never silently charged.
- Initial volume UX 10,20,30; slider 35..150 step5. FREE has separate approved cap; config may change.
- Costs and margins appear only in owner simulator. Benefit simulation follows v4 with its own disclosed assumptions (not part of transactional quote); source links must remain accurate.
- No public published offer -> clear “poproś o wycenę”/“oferta w przygotowaniu”; no active BUY button.

## Test contract
1. Per-package same addon on PRESELEKCJA/WERYFIKACJA/AC with independent prices; unavailable addon rejected; included not double-charged.
2. Fixed/per unit/tier (graduated/all-units)/bundle, discounts, VAT half-up, safe integer overflow, negative/unknown quantities, request tampering, exclusions, dependencies, stale version.
3. DB RLS anon/client/operator/owner; edit vs publish, revoke, publication concurrent, rollback, immutable history and order snapshots, DB outage.
4. Client/server/order quote parity; mobile/keyboard/no horizontal overflow; v4 marketing URL parameters never affect price.
5. Independent L3 review + PostgreSQL16 + CI on current HEAD required before integration merge.

## Implementacyjne rozdzielenie
- #140 implementuje tylko czysty silnik, bez DB/API/Next/marketing, na stałym wersjonowanym kontrakcie.
- #139 implementuje izolowany katalog i schema.
- #141 CAS publish/immutable history, #142 auth API, #145 frontend z publicznym API, #147 SC-019 adapter.
- Rozszerzenie biznesowe nie wymaga deploymentu dla już istniejących typowanych schematów; nowy techniczny execution flow zawsze wymaga implementacji i testów.
