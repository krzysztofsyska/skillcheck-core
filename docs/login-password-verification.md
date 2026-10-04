# Podgląd hasła — weryfikacja Preview 2026-10-04

Kod b786463fb8ad4b8156054fa3d5f8613ac6da2f01: Vercel success. W /login sprawdzono syntetyczny tekst (nie hasło konta): Pokaż hasło zmienia type na text, Ukryj hasło przywraca password. URL pozostał /login, formularza nie wysłano. Pole wyczyszczono przed przekazaniem użytkownikowi. Build/TypeScript i test:http PASS. To uzupełnia wcześniejszy wpis w audit-2026-10-04.md o oczekiwaniu na test Preview.

Logi Supabase: recovery HTTP 429 over_email_send_rate_limit; ostatnie odrzucone logowanie HTTP 400 invalid_credentials. Nie ustalono, która część danych logowania była niezgodna. Nie usuwano kont, nie zmieniano haseł, SMTP ani limitów.
