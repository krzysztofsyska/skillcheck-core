// Current PRESELEKCJA offer approved by the owner on 2026-10-28.
// Shown on marketing pages only; billing amounts come from the SC-019 offer table.
export const preselekcjaOffer = {
  analyses: 60,
  grossPln: 300,
  netPln: "243,90",
  validityMonths: 3,
} as const;

export const preselekcjaPrice = `${preselekcjaOffer.grossPln} zł brutto`;
export const preselekcjaScope = `${preselekcjaOffer.analyses} analiz CV`;
