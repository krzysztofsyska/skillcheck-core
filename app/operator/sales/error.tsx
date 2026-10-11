'use client';
export default function SalesError({ reset }: { reset: () => void }) {
  return <main style={{padding:32}}><h1>Nie udało się odczytać procesu sprzedaży</h1><p>Spróbuj ponownie. Jeśli problem się powtarza, skontaktuj się z administratorem.</p><button onClick={reset}>Spróbuj ponownie</button></main>;
}
