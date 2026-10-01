import Link from "next/link";

export default function Home() {
  return (
    <main>
      <section>
        <p className="eyebrow">SKILLCHECK</p>
        <h1>Sprawdzamy kompetencje, nie deklaracje.</h1>
        <p className="lead">
          Zbuduj profil stanowiska i prowadź rekrutację opartą na kompetencjach.
        </p>
        <div className="actions"><Link className="button" href="/register">Utwórz konto</Link><Link href="/login">Zaloguj się</Link></div>
      </section>
    </main>
  );
}
