import Link from "next/link";
import { login } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
import { LoginPassword } from "../components/login-password";
const messages: Record<string, string> = {
  invalid: "Podaj poprawny e-mail i hasło.",
  failed: "Nie udało się zalogować. Sprawdź dane i potwierdzenie adresu e-mail lub spróbuj ponownie za chwilę.",
  confirm: "Sprawdź skrzynkę i otwórz link potwierdzający w tej samej przeglądarce, w której tworzysz konto.",
  callback: "Nie udało się potwierdzić linku. Otwórz go w przeglądarce, w której rozpoczęto operację. Jeśli adres e-mail został już potwierdzony, zaloguj się hasłem. Dla wygasłego linku odzyskiwania hasła zamów nową wiadomość.",
};
export default async function Login({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams;
  return <main><section className="auth"><Link href="/" className="eyebrow">SKILLCHECK</Link><h1>Witaj ponownie</h1>
    <p>Zaloguj się do swojej firmy.</p>
    {message && messages[message] && <p role="status" className="notice">{messages[message]}</p>}
    <form action={login}>
      <label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <LoginPassword />
      <SubmitButton>Zaloguj się</SubmitButton>
    </form><p><Link href="/forgot-password">Nie pamiętasz hasła?</Link></p><p>Nie masz konta? <Link href="/register">Utwórz konto</Link></p>
  </section></main>;
}
