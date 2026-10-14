# SkillCheck SC-011-C — Retell + VoIPstudio/GoTrunk: przygotowanie bez telefonowania

TASK: SC-011-C | SCOPE: BACKEND | LEVEL: L3 | OWNER: ChatGPT
REVIEWER: independent Codex (latest-commit re-review required)
DEPENDS_ON: PR #116, SC-011-A, SC-012, SC-010-C worker
STATUS: OFFLINE-ONLY DRAFT, NOT DEPLOYED
PRODUCTION_APPROVAL: NO | EXTERNAL_CALLS: NO | BILLING: NO
DB/MIGRATIONS: NONE

## What is implemented in this PR

- `compileRetellOutboundDraft` is a **pure offline compiler**: NO network, SDK, POST, telephony, charge, or deployment. Retell request drafts use `override_agent_version` as an exact published **tag** (NOT numeric version or floating latest), top-level `idempotency_key`, and `honor_internal_dnc: true`. No CV/name/score metadata.
- `verifyRetellOutboundAgent` is the separate **server-side GET-only gate**, using fixed Retell URLs and `redirect: error`. It checks an exact tag's assigned numeric version and published flag, `pl-PL`, data storage `basic_attributes_only`, and a provider-side duration cap. It reads the exact referenced flow revision and requires both prompt variable placeholders in its **global prompt**; otherwise fail closed. Emits an in-memory capability valid for at most 30 seconds. It MUST be called only by authenticated trusted backend/worker with server-held credentials, never from untrusted client input.
- SC-012 released plans have a nonforgeable in-process provenance WeakSet from generated → reviewed → released transitions. The offline compiler requires an authentic released plan, exact frozen question text/IDs/followups and approved notice revision. Arbitrary text inserted even inside a valid request is rejected. This does **not** replace source freshness, durable human approval or tenant authorization at DB level.
- Provider idempotency key is included at the correct Retell request-body level. Retell's provider deduplication window is bounded; future SC-010-C worker needs durable once-only reservation and exception handling beyond that window.
- The source-approved full Retell flow JSON SHA-256 (`approvedFlowSha256`) must match the exact fetched version, including *all* nested nodes and tools. This is a strict pin to a separately reviewed immutable configuration; changes, including custom function, SMS or call-transfer additions, invalidate the gate. The hash must be reviewed and recorded by the trusted backend, never accepted from candidates, arbitrary users or client inputs.
- The agent must explicitly set a bounded storage retention of 1–30 days. The default indefinite retention is rejected, including when only basic call attributes are stored.
- Retell metadata is entirely omitted: caller-controlled correlation strings must not be retained at the provider. Provider idempotency key is restricted to a generated UUID v4 (Retell-compatible alphabet), and `honor_internal_dnc` remains true.
- Offline compiler also requires at least 420 seconds for the SC-012 approved interview and a vendor cap no shorter than that target.
- Privacy: no audio/transcripts/PII handling in this PR. If a future reporting module requires transcriptions, design a separately approved and GDPR-reviewed processing route rather than silently switching storage from basic_attributes_only.
- Three gate workflow checks; `tests/retell-outbound-draft.test.mjs` is synthetic-only with no live network.

## Manual prerequisites: VoIPstudio / GoTrunk ↔ Retell (do weryfikacji)

**Decyzja właściciela 2026-10-14:** Dostawcą telefonii i SIP jest VoIPstudio / GoTrunk (indywidualne warunki), a Retell AI pozostaje dostawcą silnika rozmowy. Wcześniejsza ścieżka Zadarma jest wycofana. Ta dokumentacja **nie potwierdza jeszcze interoperacyjności** konta GoTrunk z Retell, gotowości trunku, numeru ani wykonania połączenia.

Oficjalne materiały operatora: [GoTrunk — SIP Endpoints](https://gotrunk.com/docs/sipendpoints/), [GoTrunk — Quick Start](https://gotrunk.com/docs/quickstart/). Te instrukcje opisują SIP/PBX GoTrunk, a nie zweryfikowaną integrację GoTrunk ↔ Retell.

1. W panelu operatora potwierdzić aktywację właściwego konta VoIPstudio/GoTrunk, przypisanie usług SIP, zakres uprawnień i indywidualne warunki handlowe. **Nie kupować** nowych numerów ani pakietów bez odrębnej zgody.
2. Potwierdzić numer +48, prawo do prezentacji Caller ID, routing połączeń wychodzących, limity konta oraz faktyczną stawkę i sposób rozliczeń. Nie przyjmować publicznego cennika za warunki właściciela.
3. Zidentyfikować w panelu GoTrunk **właściwy** endpoint SIP, metodę uwierzytelnienia i trasę. Nie kopiować hosta, loginu ani hasła Zadarmy; nie wpisywać przykładowych hostów GoTrunk do Retell bez sprawdzenia kierunku połączeń i zgodności interfejsów.
4. Zweryfikować ze wsparciem lub w dokumentacji Retell obsługę tego konkretnego wariantu SIP, numeru i trybu outbound; odnotować wynik jako wymagany punkt akceptacyjny. Nie uznawać ogólnej obsługi SIP po obu stronach za dowód integracji.
5. W Retell opublikować i niezależnie zatwierdzić konkretny tag/revizję agenta, przypięty flow z `{{skillcheck_interview_script}}` i `{{skillcheck_notice_version}}`, `basic_attributes_only`, jawnie ograniczoną retencję 1–30 dni i limit rozmowy co najmniej 420 s, nie więcej niż 600 s. Dane i klucze pozostają tylko po stronie zaufanego serwera.
6. Ustawić programowo **konfigurowalną współbieżność i kolejkę** zależną od zweryfikowanych limitów Retell, GoTrunk i budżetu. Wcześniejsze 15 równoległych połączeń jest orientacyjną deklaracją, a nie potwierdzonym limitem ani sztywną wartością docelową.
7. Pierwszy test tylko na numerze kontrolowanym przez właściciela, z fikcyjnym scenariuszem, po zakończeniu kontroli SC-010-C/SC-011-B, niezależnym review i odrębnej akceptacji kosztu/testowego połączenia. Production i kandydaci pozostają wyłączeni.

## Remaining gates for any live call

- Independent Codex reviewer PASS on exact current HEAD, GitHub CI PASS, owner acceptance, protected branch rules.
- SC-010-C worker transaction proves authenticated tenant/user, documented lawful basis and candidate permission, current SC-012 plan revision, approved contact window, local DNC, correct identity and amount budget. No redirecting calls to arbitrary user numbers.
- Before **each** vendor POST: re-fetch exact agent tag/version/flow to detect reassignment; durable once-only reservation and top-level idempotency token, safe recovery on network uncertainty, retries only after reconciliation. Provider key alone is NOT sufficient across all failure modes.
- Signed Retell webhook with verification on raw bytes, replay and tenant isolation; safe mapping, storage/retention per SC-010.
- End-to-end Preview test + separately authorized paid phone test. This PR contains no POST worker and cannot place calls.

## Tests

`node --test tests/retell-outbound-draft.test.mjs`
`npm run typecheck`
`npm run build`

This is a reviewable offline artifact, not completed physical telephony, not an API deployment, not a recruitment pipeline acceptance.
