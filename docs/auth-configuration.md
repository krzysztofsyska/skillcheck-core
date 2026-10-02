# Adresy potwierdzania konta i odzyskiwania hasła

## Działanie kodu
Rejestracja przekazuje emailRedirectTo do Supabase, odzyskiwanie hasła przekazuje redirectTo. Oba używają lib/auth-url.ts. Link potwierdzający prowadzi do /auth/callback, odzyskiwanie do /auth/callback?flow=recovery. Endpoint wymienia kod PKCE, następnie kieruje do panelu lub formularza hasła. Błąd prowadzi do czytelnego komunikatu na stronie logowania; zarówno sukces, jak i błąd wyłączają cache i przekazywanie Referer.

W Vercel Preview dozwolone są wyłącznie VERCEL_BRANCH_URL i VERCEL_URL bieżącego wdrożenia. Kod ignoruje produkcyjne NEXT_PUBLIC_SITE_URL w tym środowisku. Wybiera adres Origin żądania tylko po dokładnym dopasowaniu do tej listy, żeby zachować cookie PKCE na tej samej domenie. Brak konfiguracji preview zatrzymuje wysyłkę, zamiast używać produkcji. Ręcznie dodane domeny Preview nie są jeszcze obsługiwane.

W produkcji dozwolone są NEXT_PUBLIC_SITE_URL i VERCEL_PROJECT_PRODUCTION_URL. Poza Vercel wymagane NEXT_PUBLIC_SITE_URL; lokalny tryb development domyślnie używa http://localhost:3000. Origin nie może dodawać dowolnych domen. Host i X-Forwarded-Host nie są źródłem konfiguracji. W Vercel wymagane HTTPS.

PKCE wymaga tej samej przeglądarki i domeny, na której rozpoczęto operację. UI informuje o tym przy rejestracji, potwierdzeniu i błędzie linku. Domyślny szablon Supabase powinien używać ConfirmationURL; niestandardowe szablony trzeba oddzielnie sprawdzić.

## Ustawienia nadal do wykonania w panelu
Kontrola 2026-10-01 wykazała inne domeny w Supabase niż aktualna produkcja i preview. Ta zmiana w kodzie nie modyfikuje allowlisty Supabase.

Site URL dla produkcji: https://skillcheck-core.vercel.app
Dokładne adresy Redirect URLs dla produkcji:
- https://skillcheck-core.vercel.app/auth/callback
- https://skillcheck-core.vercel.app/auth/callback?flow=recovery

Dla aktualnego adresu gałęzi testowej:
- https://skillcheck-core-git-feat-te-a48cba-krzysztofs-projects-b7ce87b5.vercel.app/auth/callback
- https://skillcheck-core-git-feat-te-a48cba-krzysztofs-projects-b7ce87b5.vercel.app/auth/callback?flow=recovery

Jeśli testy zaczynają się na adresie konkretnego wdrożenia (VERCEL_URL), jego callbacki również muszą być dopuszczone. Przed zmianą ustawień potwierdzić aktualne domeny; nie rozszerzać allowlisty na wszystkie projekty/konta. Dla localhost dodać tylko używany port na czas testów. NEXT_PUBLIC_SITE_URL w Vercel ustawić osobno dla produkcji, zachować dostępność systemowych zmiennych wdrożenia.

## Weryfikacja
- test:auth obejmuje osobne środowiska, domeny gałęzi i wdrożenia, brak konfiguracji, obce Origin, niedozwolone schematy i nieprawidłowe wartości.
- test:auth-http uruchamia prawdziwy build Next oraz lokalną atrapę protokołu Supabase Auth. Wysyła formularze rejestracji i odzyskiwania hasła, sprawdza redirect_to, PKCE challenge i cookie weryfikatora oraz obsługę nieprawidłowego callbacku. Nie wysyła poczty i nie testuje rzeczywistego Supabase Auth.
- Nadal wymagane: ustawienia panelu, prawdziwa dostawa poczty, potwierdzenie konta i odzyskanie hasła na tym samym adresie/przeglądarce, zapis firmy oraz izolacja dwóch zalogowanych kont.

Źródła API:
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/auth/passwords
- https://vercel.com/docs/environment-variables/system-environment-variables
