/** SC-020-B: komunikaty po akcjach na stronie domen (klucz z parametru `status`). */
export const domainNotices = {
  claimed: 'Domena dodana. Dodaj rekord DNS z instrukcji poniżej, a potem kliknij „Sprawdź”.',
  invalid: 'To nie jest poprawna nazwa domeny. Wpisz samą nazwę, np. kariera.twojafirma.pl.',
  reserved: 'Tej nazwy nie można użyć (adres techniczny lub zarezerwowany).',
  taken: 'Ta nazwa jest już używana albo zgłoszona w tej firmie.',
  limit: 'Osiągnięto limit domen dla firmy. Odwołaj nieużywaną domenę.',
  subdomains_disabled: 'Subdomeny platformy nie są jeszcze włączone.',
  verified: 'Rekord DNS potwierdzony.',
  ready: 'Domena sprawdzona: rekord DNS i certyfikat są w porządku. Możesz ją włączyć.',
  dns_missing: 'Nie znaleźliśmy rekordu DNS. Zmiany u dostawcy DNS mogą potrwać do kilku godzin.',
  dns_unavailable: 'Nie udało się teraz sprawdzić DNS. Spróbuj ponownie za chwilę.',
  tls_pending: 'Rekord DNS jest w porządku, ale certyfikat dla tej domeny nie jest jeszcze gotowy.',
  conflict: 'Ta domena jest już potwierdzona przez inne konto. Jeśli to Twoja domena, skontaktuj się z nami.',
  verifier_unavailable: 'Sprawdzanie domen nie jest dostępne w tym środowisku.',
  activated: 'Domena włączona.',
  not_ready: 'Domenę można włączyć dopiero po potwierdzeniu DNS i certyfikatu.',
  deactivated: 'Domena wyłączona.',
  revoked: 'Domena odwołana. Ponowne użycie wymaga nowej weryfikacji.',
  failed: 'Nie udało się wykonać operacji. Spróbuj ponownie.',
} as const;
export type DomainNotice = keyof typeof domainNotices;
