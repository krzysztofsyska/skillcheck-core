// SC-METHOD / #275 — powiązanie definicji zadań z wersją profilu metody.
// Jedno miejsce dla WSZYSTKICH akcji serwera, które tworzą albo zatwierdzają
// wersję definicji zadania (zapis ręczny, korekta propozycji AI, wygenerowanie
// propozycji AI, zatwierdzenie propozycji AI). Kontrakt: docs/sc-method-275.md.
//
// Baza wiąże wszystkie jeszcze niepowiązane definicje rekrutacji według reguły
// czasu (wersja metody obowiązująca w chwili utworzenia definicji), więc akcja
// nie musi znać id nowej definicji, a ponowne wywołanie niczego nie zmienia.
//
// Zadanie jest już zapisane, gdy ta funkcja rusza: jej błąd nie może cofnąć
// zapisu ani pokazać rekruterowi fałszywego „nie zapisano". Dlatego nigdy nie
// rzuca i nic nie zwraca do interfejsu. Błąd trafia do logu serwera — sam kod,
// bez treści komunikatu bazy i bez żadnych danych.

type BindingClient = {
  rpc(name: 'method_bind_recruitment_definitions', args: { target_company: string; target_recruitment: string }):
    PromiseLike<{ data: unknown; error: { code?: string | null } | null }>;
};

const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(value) ? value : 'unknown';

export async function bindMethodToDefinitions(client: BindingClient, companyId: string, recruitmentId: string,
  log: (message: string) => void = console.error): Promise<void> {
  try {
    const result = await client.rpc('method_bind_recruitment_definitions', { target_company: companyId, target_recruitment: recruitmentId });
    if (result.error) log(`method_bind_failed code=${safeCode(result.error.code)}`);
  } catch {
    log('method_bind_failed code=exception');
  }
}
