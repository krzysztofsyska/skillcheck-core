# SC-PRICING-001 — wersjonowany kontrakt systemu oferty (v1)
**TASK:** SC-SALES-MODULAR-PRICING / #137 / #138. **LEVEL:** L3. **SCOPE:** OPERATIONS (architektura i kontrakt; projekt nadrzędny FULLSTACK).
**Status:** propozycja do niezależnego review; nie jest zatwierdzoną ofertą handlową ani zgodą na migracje Production.

## Granice domeny
1. **Product catalog:** globalny/scope-specific `Package`, `Service`, `PackageService`, `CapabilityRegistry`. Znaczenie `service_code` stabilne; nazwy/opisy/taryfy wersjonowane. System nie zakłada zamkniętej listy dodatków w UI.
2. **Pricing:** czysta, deterministyczna serwerowa funkcja `quoteOffer(offerVersion, validatedRequest, authoritativeRuntimeCapabilities, {allowDraft?})`; żadnych odczytów tenant balance, payment provider ani kosztów z publicznego API. `pricing_method` jest typowaną enumeracją (bez JS/SQL od admina).
3. **Commercial publishing:** stany `DRAFT → VALIDATED → PUBLISHED → SUPERSEDED`, historia i transactionally switched active pointer. `ARCHIVED` tylko dla porzuconych draftów; immutable published snapshot.
4. **Private costs:** osobna domena/tabela, brak kluczy i pól kosztowych w `public` schema, endpointach, preview i serializowanych pakietach dla klienta.
5. **SC-019 bridge:** osobny adapter z immutably snapshotted `quote.versionId`, line items, PLN gross, terms; ledger/kredyty/płatności należą wyłącznie do SC-019.

## Typy danych i niezmienniki
```ts
// SC-PRICING v1 DTO — resolved pricing payload (DB can store versioned rule IDs,
// but must resolve those IDs server-side before calling quoteOffer()).
type PackageCode = 'FREE' | 'PRESELEKCJA' | 'WERYFIKACJA' | 'ASSESSMENT_CENTER';
type CommercialStatus = 'hidden' | 'informational' | 'on_request' | 'purchasable';
type TechnicalStatus = 'planned' | 'prototype' | 'verified'; // verified alone is NOT a runtime permit
type Unit = 'cv' | 'candidate' | 'interview' | 'test' | 'scenario' | 'minute' | 'hour' | 'item';
type PriceVersionState = 'DRAFT' | 'VALIDATED' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED';
type MoneyMinor = number; // safe integer PLN grosze, 0..1_000_000_000_000
type SignedMoneyMinor = number; // safe integer PLN grosze, -1_000_000_000_000..+1_000_000_000_000; ONLY line deltas
type BasisPoints = number; // safe integer 0..10000
// v1 methods. `bundle` is NOT part of v1: a catalog containing any method not listed here is rejected
// at publish and quote time (UNSUPPORTED_RULE). Bundles may return in a separately reviewed v2.
type PriceRule =
  | Readonly<{ method: 'fixed'; amountMinor: MoneyMinor }>
  | Readonly<{ method: 'per_unit'; unitMinor: MoneyMinor }>
  | Readonly<{ method: 'volume_tier'; mode: 'graduated' | 'all_units';
      tiers: readonly Readonly<{ upTo: number | null; unitMinor: MoneyMinor }>[] }>
  | Readonly<{ method: 'tiered_flat';
      tiers: readonly Readonly<{ upTo: number | null; amountMinor: MoneyMinor }>[] }>;
// Owner-facing modes (panel) map onto these rules:
// CV volume — "baza + stawka za CV": Plan.baseNetMinor + cvIncluded + cvOverageRule per_unit/volume_tier;
//             "progi cenowe": Plan.baseNetMinor (may be 0) + cvIncluded=0 + cvOverageRule tiered_flat.
// Add-ons   — "cena za sztukę": per_unit (or volume_tier); "stała cena": fixed.
interface CvPolicy { quick: readonly number[]; range: { min: number; max: number; step: number } | null; }
interface Plan {
  code: PackageCode; commercialStatus: CommercialStatus;
  baseNetMinor: MoneyMinor | null; cvIncluded: number; cvPolicy: CvPolicy;
  cvOverageRule?: PriceRule | null; capabilityCode: string | null;
}
interface Service {
  code: string; name: string; description: string; category: string; unit: Unit;
  min: number; max: number; step: number; capabilityCode: string | null;
  technicalStatus: TechnicalStatus; commercialStatus: CommercialStatus;
  dependencies: readonly string[]; exclusions: readonly string[]; sortOrder: number; visible: boolean;
  defaultPriceRule?: PriceRule | null;
}
interface PlanService {
  packageCode: PackageCode; serviceCode: string; allowed: boolean; visible: boolean;
  includedQuantity: number; maxQuantity: number; quantityStep: number; extraAllowed: boolean;
  autoPurchase: boolean; commercialStatus: CommercialStatus;
  overridePriceRule?: PriceRule | null; // override resolved from versioned DB rule reference
}
type DiscountRule =
 | Readonly<{ code: string; method: 'percent'; value: BasisPoints; eligiblePackages: readonly PackageCode[] }>
 | Readonly<{ code: string; method: 'amount'; value: MoneyMinor; eligiblePackages: readonly PackageCode[] }>;
interface OfferVersion {
  versionId: string; status: PriceVersionState; approved: boolean; currency: 'PLN';
  vatBasisPoints: BasisPoints; plans: readonly Plan[]; services: readonly Service[];
  planServices: readonly PlanService[]; discounts: readonly DiscountRule[];
}
interface QuoteRequest {
  expectedVersionId: string; packageCode: PackageCode; cvCount: number;
  addons: readonly Readonly<{ serviceCode: string; quantity: number }>[];
  // Strict server input parser rejects unknown fields and duplicate addon serviceCode.
}
interface QuoteLine {
  kind: 'base' | 'cv_overage' | 'service' | 'discount';
  code: string; quantity: number; included: number; billed: number; netMinor: SignedMoneyMinor;
}
interface QuoteResult {
  versionId: string; packageCode: PackageCode; currency: 'PLN'; vatBasisPoints: BasisPoints;
  lines: readonly QuoteLine[]; subtotalNetMinor: MoneyMinor; discountMinor: MoneyMinor;
  netMinor: MoneyMinor; vatMinor: MoneyMinor; grossMinor: MoneyMinor;
  canPurchase: boolean; unavailableCapabilities: readonly string[];
  // Stable machine codes explaining canPurchase=false; empty iff canPurchase=true.
  // Codes: PACKAGE_NOT_PURCHASABLE, ADDON_REQUIRES_OPERATOR:<serviceCode>,
  //        CAPABILITY_UNAVAILABLE:<capabilityCode>, ON_REQUEST_PRICE:<code>.
  blockedReasons: readonly string[];
}
```
Baza: `pricing_scope`, `price_versions`, `services`, `packages`, `package_services`, `price_rules`, `pricing_audit`, `active_price_pointer`, `private_pricing_costs`, `private_pricing_quotes`. Reguła w bazie może być wskazana przez immutable `rule_id`, ale snapshot przekazywany do silnika **musi zawierać pełną typowaną wartość `PriceRule`** po serwerowym rozwiązaniu powiązań (default + per-package override). Relacje i keys sklejone z immutable version ID; `service_code` unikatowy w zakresie wersji, **`(version_id,packageCode)` w packages** i `(version_id,packageCode,service_code)` w package_services są unikatowe (constraint PK + sprawdzenie Map bez nadpisywania na serwerze); brak CAS po stronie klienta. Nie edytować danych historycznego zamówienia ani publikacji.

### Walidacja przed publish (po stronie DB i serwera)
- Najwyżej jedna aktywna oferta na **pełny, ustalony klucz** `(pricing_scope_id, locale, currency, audience)`; publikacja blokuje/zmienia pointer wyłącznie dla identycznego klucza. Zakres początkowy: publiczny pl-PL / PLN; w przyszłości inne scope mogą mieć własne wersje. Zero aktywnej oferty to poprawny stan „brak cennika”.
- Każdy pakiet ma jawny status, bazową cenę lub `on_request`, limity; **status `purchasable`** oraz publikowanie `PUBLISHED`/`SUPERSEDED` wymaga zatwierdzenia `approved=true`, zatwierdzonej ceny, regulaminu, docelowego procesu technicznego, wdrożonych uprawnień i serwerowo potwierdzonej capability.
- Usługa może mieć wiele PackageService; konfiguracja WERYFIKACJA nie przenosi się automatycznie do AC; included per package ma pierwszeństwo. Podstawowa usługa wyceniana tylko raz.
- Sprawdzać `min <= max`, step, spójność unit/threshold, ilości z formularza, brak cykli dependencies, brak wzajemnych exclusions, zależności między usługami przypisanymi do tej samej oferty. Dla każdej relacji `(version_id,package,service)` pola `includedQuantity`, `maxQuantity` i `quantityStep` muszą być bezpiecznymi całkowitymi i spełniać `0 <= includedQuantity <= maxQuantity <= globalService.max <= 100000`, `quantityStep > 0`, `extraAllowed=false` zakazuje ilości powyżej included; ilość nadwyżki musi być wielokrotnością `quantityStep`; uwzględniać też globalne min/max i jednostkę. Te same rygory muszą obowiązywać przy wycenie, niezależnie od walidacji publikacji.
- Walidować także plan: `cvIncluded` całkowite 0..100000 i nie większe od największego dopuszczalnego wolumenu, `CvPolicy.quick` unikatowe dodatnie safe integers 1..100000, rosnące; `range` null albo dodatnie safe integers `min <= max <=100000`, `step>0`, dopuszczalne `qty` to `quick` LUB `range.min + n*range.step` do max. Przy rozdzielnych presetach 10/20/30 i zakresie 35–150 presety mogą być poza zakresem slidera; nie oznacza to błędu. Każde qty żądania musi należeć do tak zdefiniowanego zbioru. Walidować przy publish i quote.
- Reguły `volume_tier` i `tiered_flat`: 1..32 progi, kolejno `upTo` jako ściśle rosnące dodatnie safe integers do 100000; **tylko ostatni tier ma `upTo:null`** (nieograniczona końcówka), przynajmniej jeden próg i każda kwota 0..max. `upTo` jest **włącznie**: dla qty=100 stosuje się tier do 100; `graduated` liczy przedziały (poprzednia granica+1..bieżąca), `all_units` stawkę całego qty według jednego kwalifikującego progu. `tiered_flat` nalicza **jedną kwotę `amountMinor`** pierwszego progu, którego `upTo >= billedQuantity` (dla `billedQuantity = 0` linia wynosi 0); gdy ostatni próg ma liczbę, a ilość ją przekracza, wycena jest odrzucana (`QUANTITY_OUT_OF_RANGE`). Zawsze walidacja publish i quote.
- Metoda `bundle` i każda nieznana metoda: odrzucenie przy publish i quote (`UNSUPPORTED_RULE`).
- Rabaty: percent `value` wyłącznie safe integer w basis points `0..10000`, amount wyłącznie safe integer grosze `0..1e12`, unikalne kody, brak nienazwanych/zduplikowanych reguł, bez ujemnych wartości i dowolnych formuł. Walidować publish i quote, obniżenie max do dostępnej podstawy netto (bez wartości ujemnej).
- **Granice kwot osiągalnych:** przy publish serwer i DB liczą dla każdego planu najwyższą osiągalną wycenę: bazę + `cvOverageRule` przy największym dopuszczalnym wolumenie CV + każdy dozwolony dodatek przy `maxQuantity` (bez rabatów), następnie VAT half-up. Każda linia, suma netto, VAT i brutto muszą mieścić się w `MoneyMinor` (≤ 1e12). Wersja, która dopuszcza wybór poza tym zakresem, nie może zostać opublikowana (`AMOUNT_OUT_OF_RANGE`). Wycena sprawdza ten sam limit dla każdej linii i sum i odrzuca wynik poza zakresem, zamiast go obcinać.
- **`autoPurchase`:** `true` oznacza, że dodatek można kupić automatycznie w checkout. `false` oznacza „dodatek na zapytanie”: wycena go **nie odrzuca**, pokazuje cenę, ale ustawia `canPurchase=false` i dodaje do `blockedReasons` kod `ADDON_REQUIRES_OPERATOR:<serviceCode>`; checkout zawsze odrzuca taki koszyk. Publikacja odrzuca sprzeczne kombinacje: `autoPurchase=true` wymaga `allowed=true` i `commercialStatus='purchasable'` w `PlanService`; `allowed=false` wymaga `autoPurchase=false` i `visible=false`; `commercialStatus` relacji `hidden` wymaga `visible=false`. Gotowość capability jest sprawdzana niezależnie przy każdej wycenie (`CAPABILITY_UNAVAILABLE:<code>`).
- Status `verified` zapisany przez admina nie jest wystarczającym potwierdzeniem `runtimeCapabilityReady`. Cytowany parametr `authoritativeRuntimeCapabilities` musi pochodzić wyłącznie z serwerowego rejestru bieżącej gotowości, zostać ustalony przy wycenie i ponownie sprawdzony w transakcji checkout. `quoteOffer()` przyjmuje ten zbiór (ReadonlySet) jako trzeci parametr; nie wolno go odczytywać z requestu ani identyfikować z admin `technicalStatus`. Żadnej automatycznej sprzedaży `planned/prototype`.
- Zatwierdzony grosz/VAT/terms i spójne wersje dla całego snapshotu; brak roboczych cen z marketingu lub pliku v4 w seedach.

## Reguły finansowe (wersja algorytmu `pln-v1`)
- Wszystkie ceny **netto w całkowitych groszach**; wynik jest w PLN.
- Podstawowy wolumen CV oraz inne usługi liczone według **odrębnych**, walidowanych reguł; `extraQuantity = max(0, requested - included)`. Included ma 0 charge; wszystkie linie muszą wskazywać jawnie usługi/ilości.
- `fixed`: jednorazowa kwota (jeśli dana usługa jest wybrana ponad ilość wliczoną), `per_unit`: stała cena × dodatkowa ilość; `volume_tier`: jedna spójna polityka `graduated` albo `all_units` wskazana przez version; `tiered_flat`: kwota progu obejmującego dodatkową ilość (0 przy braku nadwyżki). `bundle` nie występuje w v1.
- Rabat stosowany do dozwolonej podstawy netto, nie może dać wyniku ujemnego. Nie zaokrąglać ułamków liczbą float: operacje BigInt + kontrola max safe, procent w basis points, reguła **half-up**. Każdy rabat zaokrągla się osobno na pozostałej agregowanej podstawie netto (kolejność reguł jest częścią niezmiennej wersji). **VAT obliczamy i zaokrąglamy tylko raz dla sumy netto po wszystkich rabatach**, nie dla poszczególnych linii: `vatMinor = halfUp(discountedNet × vatBps / 10000)`; `grossMinor = discountedNet + vatMinor`. Linie przedstawiają kwoty netto (rabat jako osobna ujemna linia); **nie przypisujemy VAT do linii i nie rozdzielamy reszty podatkowej między pozycje**. Publiczny widok, backend i SC-019 przechowują identyczny VAT i gross z jednej wyceny; jeśli fakturowanie wymaga VAT per pozycja lub różnych stawek, potrzebna osobna wersja reguły i zgodność z wymaganiami podatkowymi przed publikacją.
- Wycena odmawia gdy brak ceny, brak PUBLISHED dla klienta, nieobsługiwana reguła, niewłaściwa quantity/step, niespełnione prerequisites, nieaktywny dodatek, niespójne statusy lub `expectedVersionId` różni się od aktualnego.
- Cennik FREE może mieć 0 zł netto wyłącznie przy jawnie zatwierdzonym publicznym planie; nie interpretować braku ceny jako zera.

## API contracts
- `GET /api/pricing/catalog`: `{versionId,validUntil,packages:[{code,description,status,cvOptions,services:[{code,name,unit,qty,priceDisplay,status}]}]}`. Only published, cache invalidation on publish, no costs/cost markup/internal statuses/secrets/drafts.
- `POST /api/pricing/quote`: input strictly `QuoteRequest` (`packageCode`, `cvCount`, `addons`, `expectedVersionId`); server-side selection, constraints & pricing; display response is exactly the public projection of `QuoteResult`: `{versionId,packageCode,currency:'PLN',vatBasisPoints,lines,subtotalNetMinor,discountMinor,netMinor,vatMinor,grossMinor,canPurchase,unavailableCapabilities,blockedReasons}` (no other eligibility field; `canPurchase` is a UI hint, not authorization). Dla anonimowego podglądu **nie wydawać uprawnienia do zakupu ani zaufanego `quoteId`**. Dla uwierzytelnionego checkout zaufany serwer wystawia osobny, niezgadywalny `quoteId` i `expiresAt` na podstawie dokładnie tego wyniku (niżej). Price/discount fields in browser input forbidden.
- `/api/operator/pricing/**`: authenticated owner, separate capabilities `pricing_edit` and `pricing_publish`. Editing never publishes; publishing requires server confirmation token bound to version+hash, audit actor/old/new, CAS and atomicity.
- `GET /api/operator/pricing/preview?versionId`: read draft as a **public projection**, never serialized with internal costs.
- Quote order integration (future #147): **zaufany artefakt wyceny** w `private_pricing_quotes` powstaje jedynie po uwierzytelnieniu konta firmy i uprawnienia do zakupu; zawiera losowe UUID `quoteId`, `company_id`, `buyer_id`, pełny `pricing_scope_id` i aktywne `versionId`, canonical `QuoteRequest` i jego digest, niezmienny `QuoteResult` z pozycjami/net/VAT/gross, zaakceptowany `terms_revision`, `created_at`, krótki `expiresAt` i identyfikator walidacji capability. Domyślnie brak browser CRUD / RLS deny; rekord jest append-only do czasu retencji, deduplikacja finalizacji należy do SC-019. Server checkout z autoryzowanej sesji **transakcyjnie** sprawdza tenant/buyer/quote expiry, status i identyczność current published version + pricing scope, potwierdza nadal aktualną capability, odtwarza/porównuje wycenę oraz wiąże niezmienny snapshot ekonomiczny z nowym SC-019 order. Nie przyjmuje kwot, rabatów, obcej sesji ani `terms_revision` od klienta. Przy zmianie wersji klient otrzymuje konflikt i nową wycenę do ponownej akceptacji; provider gross jest porównywany z kwotą SC-019, grant kredytów wyłącznie po zweryfikowanym settlement. Publiczny `canPurchase` stanowi wskazówkę UI, **nie autoryzację**.

### Rozstrzyganie zakresu cennika (scoped offer resolver)
- `pricing_scope_id` nigdy nie pochodzi z pola sterującego klienta, URL ani niezaufanego companyId. **Jedna wspólna serwerowa funkcja** `resolvePricingScope(authenticatedActor, verifiedCompanyMembership, locale, currency)` obsługuje zarówno GET catalog, jak i POST quote oraz checkout.
- Dla anonimowego klienta zawsze ogólnodostępny scope `global_public_pln` (pl-PL / PLN). Scope przypisany firmie może być rozpatrzony wyłącznie po uwierzytelnieniu i DB potwierdzonym członkostwie/uprawnieniu zakupu, nie z JWT user_metadata.
- Dla uprawnionej firmy: jeśli istnieje jawnie skonfigurowany scope firmowy, musi on mieć własny PUBLISHED pointer; brak aktywnej wersji daje **brak oferty**, bez cichego fallbacku do globalnego. Jeśli **nie ma** firmowego scope, używaj globalnego. Tenantowe odczyty nie są cache'owane jako publiczne; publiczny cache ma scope-aware key i invalidację publikacji.
- Wybrany scope/version/terms muszą zostać zapisane w artefakcie quote i powtórnie zweryfikowane przy checkout; nienależące do firmy wersje są odrzucane.

### Zgoda na warunki a artefakt wyceny
- Publiczna wycena anonimowa to **wyłącznie podgląd**. Sam `QuoteRequest` nie zawiera akceptacji warunków ani nie może automatycznie jej oznaczać. Wydanie zaufanego quote do checkout wymaga osobnego kroku.
- Po uwierzytelnieniu buyer i potwierdzeniu uprawnień do firmy `POST /api/pricing/terms-acceptance` przyjmuje `{expectedVersionId, accepted:true}`; serwer sam odczytuje niezmienny hash/`terms_revision` aktualnego published scope, wymaga świadomego zaznaczenia potwierdzenia w UI i utrwala append-only `private_pricing_terms_acceptances` z buyer/company/scope/version/termsHash/termsRevision/acceptedAt/audit actor (bez fałszywych domyślnych zgód).
- Następnie serwer może utworzyć `private_pricing_quotes` wyłącznie jeśli istnieje prawidłowa akceptacja tych samych warunków (osobny acceptanceId, nie podstawiany przez browser), wersji i kupującego; `terms_revision` w quote jest skopiowane wyłącznie z tej zatwierdzonej akceptacji. Checkout poddaje ją ponownej weryfikacji i wiąże z immutable SC-019 order.
- **Wygasanie akceptacji:** serwer zapisuje jawne `expiresAt = acceptedAt + 24 h` (stała polityki `TERMS_ACCEPTANCE_TTL = PT24H`, część wersji algorytmu `pln-v1`; zmiana wymaga nowej wersji kontraktu). Akceptacja jest ważna wyłącznie, gdy `now < expiresAt` **oraz** nie zmieniły się: wersja cennika, `termsHash`/`termsRevision`, firma, kupujący ani jego uprawnienie. `quote.expiresAt` nie może być późniejszy niż `expiresAt` akceptacji. Checkout ponownie sprawdza oba terminy w tej samej transakcji.
- Zmiana wersji, warunków, firmy, uprawnienia lub przedawnienie akceptacji wymaga ponownego potwierdzenia. Samo wyświetlenie kosztu, quoteId lub redirect do płatności nie stanowi zgody.

## Granice bezpieczeństwa
- Public/anon: published catalogue and public quote only, no edits, drafts, private costs. Owner: authenticated global platform role independent of `platform_operator_status`; revocation checked at DB write time. Tenant company owners **do not** inherit pricing management.
- PostgreSQL: explicit RLS/GRANT for every table/RPC, SECURITY DEFINER pinned `search_path`, strict auth role and row checks, idempotent publish key and actor audit. Race prevention via unique active scope + transactional lock + expected revision.
- Neither browser nor marketing link sets amountMinor, discount, pricing tier, version status, technical readiness or entitlement. Strict bounded inputs, reject unknown fields and **duplicate addon codes** (no double included/tier counting) in API; `QuoteRequest` exact four top-level keys. Preview-only drafts can be priced solely on separately authorized owner endpoint, never checkout. Atomic `quoteId` storage is not the credit/payment ledger.
- No payment/live callbacks to activate feature; trust only SC-019 verified settlement. No production DB migrations in this task.

## UI behavior and fallback
- URL may select package, CV count, addon and attribution; unknown/addon incompatible with new package is cleared, never silently charged.
- Initial volume UX 10,20,30; slider 35..150 step5. FREE has separate approved cap; config may change.
- Costs and margins appear only in owner simulator. Benefit simulation follows v4 with its own disclosed assumptions (not part of transactional quote); source links must remain accurate.
- No public published offer -> clear “poproś o wycenę”/“oferta w przygotowaniu”; no active BUY button.

## Test contract
1. Per-package same addon on PRESELEKCJA/WERYFIKACJA/AC with independent prices; unavailable addon rejected; included not double-charged.
2. Fixed/per unit/tier (graduated/all-units)/tiered_flat, rejected bundle/unknown method, discounts, VAT half-up, reachable-amount bound at publish and quote, autoPurchase=false → `ADDON_REQUIRES_OPERATOR`, negative/unknown quantities, request tampering, exclusions, dependencies, stale version, expired terms acceptance.
3. DB RLS anon/client/operator/owner; edit vs publish, revoke, publication concurrent, rollback, immutable history and order snapshots, DB outage.
4. Client/server/order quote parity; mobile/keyboard/no horizontal overflow; v4 marketing URL parameters never affect price.
5. Independent L3 review + PostgreSQL16 + CI on current HEAD required before integration merge.

## Implementacyjne rozdzielenie
- #140 implementuje tylko czysty silnik, bez DB/API/Next/marketing, na stałym wersjonowanym kontrakcie.
- #139 implementuje izolowany katalog i schema.
- #141 CAS publish/immutable history, #142 auth API, #145 frontend z publicznym API, #147 SC-019 adapter.
- Rozszerzenie biznesowe nie wymaga deploymentu dla już istniejących typowanych schematów; nowy techniczny execution flow zawsze wymaga implementacji i testów.
