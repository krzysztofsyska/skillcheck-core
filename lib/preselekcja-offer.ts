// Owner-approved package figures, kept free of server-only imports so both the
// marketing pages (server) and the checkout screen (client) can read them.
//
// PRESELEKCJA: owner decision 2026-10-28, reconfirmed 2026-11-01 and 2026-11-02.
// FREE: owner decision 2026-11-02.

export const preselekcjaOffer = {
  analyses: 60,
  grossPln: 300,
  netPln: "243,90",
  validityMonths: 3,
} as const;

export const freeOffer = {
  analyses: 5,
  grossPln: 0,
} as const;
