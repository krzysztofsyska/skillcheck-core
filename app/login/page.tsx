import Link from "next/link";
import { login } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
const messages: Record<string, string> = {
  invalid: "Podaj poprawny e-mail i hasło.",
  failed: "Nie udało się zalogować. Sprawdź dane i potwierdzenie adresu e-mail lub spróbuj ponownie za chwilę.",
  confirm: "Sprawdź skrzynkę i potwierdź adres linkiem z wiadomości. Następnie wróć tutaj i zaloguj się.",
};
export default async function Login({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams;
  return <main><section className="auth"><Link href="/" className="eyebrow">SKILLCHECK</Link><h1>Witaj ponownie</h1>
    <p>Zaloguj się do swojej firmy.</p>
    {message && messages[message] && <p role="status" className="notice">{messages[message]}</p>}
    <form action={login}>
      <label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label>Hasło<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <SubmitButton>Zaloguj się</SubmitButton>
    </form><p>Nie masz konta? <Link href="/register">Utwórz konto</Link></p>
  </section></main>;
}
