# SkillCheck — ograniczenie automatycznych wdrożeń Vercel

## Zakres

Vercel projekt `skillcheck-core` połączony z `krzysztofsyska/skillcheck-core`.
`vercel.json` zawiera politykę `git.deploymentEnabled`:

- `main`: pozostaje dotychczasową gałęzią produkcyjną; **wdrożenia produkcyjne wymagają odrębnej zgody właściciela**.
- `integration`: automatyczne Preview po scaleniu.
- `release/**`: automatyczne Preview dla gałęzi wydaniowych.
- wszystkie pozostałe gałęzie (np. `feat/**`, `fix/**`, `cursor/**`, `chore/**`): bez automatycznego Preview po każdym commicie.

Podstawę reguł stanowi dokumentacja Vercel: https://vercel.com/docs/project-configuration/git-configuration .
Gdy gałąź pasuje do dwóch wzorców, dopasowanie z wartością `true` ma pierwszeństwo.
Plik `vercel.json` nie zmienia samodzielnie ustawień projektu ani aktywnej produkcji.

## Aktywacja i zachowanie aktywnych gałęzi

1. Po pozytywnym GitHub Actions oraz code review scalić PR wyłącznie do `integration` — za zgodą właściciela.
2. Każda **nowa** gałąź robocza utworzona z aktualnego `integration` odziedziczy `vercel.json`.
3. Wcześniej utworzone gałęzie robocze trzeba uaktualnić z `integration`; sam merge tego PR nie wyłącza ich dotychczasowych automatycznych wdrożeń. Sprawdzić konflikty przed synchronizacją.
4. Przed zmianą ochrony gałęzi sprawdzić, czy status `Vercel` Preview nie jest obowiązkowym checkiem dla wszystkich PR. W przeciwnym razie brak automatycznego Preview może zablokować scalanie.
5. Ręcznie wybrane testowe wdrożenia można nadal wykonywać zgodnie z uprawnieniami zespołu. Nie wdrażać automatycznie na Production.

## Kontrola

`node --test tests/vercel-deployment-policy.test.mjs`

Ten test sprawdza oczekiwane ustawienia zapisane w repozytorium. Nie zastępuje weryfikacji wdrożeń i reguł po scaleniu. GitHub Actions działa niezależnie od automatycznych wdrożeń Vercel.
