TASK: SC-SALES-INVESTOR-HOME (#58)
STATUS: PREVIEW / OWNER REVIEW
LEVEL: L1
SCOPE: FRONTEND
OWNER: Codex
REVIEWER: Codex (same-session review)
DEPENDS ON: marketing homepage; integration 9307d8c

Adapted the corrected investor memorandum into customer-facing narrative: hero, recruitment cost/problem, audiences, job context, future Quality of Hire, company identity and contact. No investor financials, quantitative promises or claim that planned features are live. Registration remains separate and available through the footer. Existing demo and contact routes retained.

TESTS: build PASS; typecheck PASS; Chromium 1440px/390px PASS: single h1, no overflow, mobile menu/about anchor, demo navigation, no page errors. Desktop and mobile screenshots inspected/generated under docs/previews. React review: server component, no new fetching/dependencies/client state, semantic headings and existing focus navigation retained.
DB/MIGRATIONS: none. Secrets/auth/production: unchanged. Contact form activation remains separate.
NEXT: owner visual feedback; preview only, no merge or production promotion.
