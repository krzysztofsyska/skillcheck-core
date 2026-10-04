"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main><section className="auth"><h1>Nie udało się wczytać strony</h1><p>Sprawdź połączenie i spróbuj ponownie za chwilę.</p><button onClick={reset}>Spróbuj ponownie</button></section></main>;
}
