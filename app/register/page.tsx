import Link from "next/link";
import { register } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
import { LEGAL_ACCEPTANCE_FIELD, LEGAL_ACCEPTANCE_VALUE } from "../../lib/legal";
import { SiteFooter } from "../components/marketing/site-footer";
export default async function Register({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const { message } = await searchParams;
  return <><main><section className="auth"><Link href="/" className="eyebrow">SKILLCHECK</Link><h1>Utwórz konto</h1>
    <p>Zacznij od konta. Po potwierdzeniu e-maila skonfigurujesz firmę. Link z wiadomości otwórz w tej samej przeglądarce.</p>
    {message && <p role="alert" className="notice">{message === "invalid" ? "Podaj poprawny e-mail i hasło mające co najmniej 12 znaków." : message === "terms" ? "Aby utworzyć konto, zaakceptuj Regulamin wraz z Umową powierzenia danych i potwierdź zapoznanie się z Polityką prywatności." : message === 'unavailable' ? 'Rejestracja pod tym adresem jest chwilowo niedostępna. Administrator musi sprawdzić konfigurację adresu aplikacji.' : "Nie udało się utworzyć konta. Spróbuj ponownie za chwilę lub zaloguj się, jeśli masz już konto."}</p>}
    <form action={register}>
      <label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label>Hasło<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-describedby="password-help" /></label>
      <small id="password-help">Co najmniej 12 znaków.</small>
      <label className="consent"><input type="checkbox" name={LEGAL_ACCEPTANCE_FIELD} value={LEGAL_ACCEPTANCE_VALUE} required />
        <span>Akceptuję <Link href="/regulamin" target="_blank">Regulamin</Link> wraz z <Link href="/regulamin/umowa-powierzenia" target="_blank">Umową powierzenia przetwarzania danych (DPA)</Link> i <Link href="/regulamin/aneks-rozmowy-glosowe" target="_blank">Aneksem nr 1 (rozmowy głosowe)</Link> oraz potwierdzam zapoznanie się z <Link href="/polityka-prywatnosci" target="_blank">Polityką prywatności</Link>. Działam w imieniu firmy i jestem do tego upoważniony/a.</span></label>
      <SubmitButton>Utwórz konto</SubmitButton>
    </form><p>Masz już konto? <Link href="/login">Zaloguj się</Link></p>
  </section></main><SiteFooter /></>;
}
