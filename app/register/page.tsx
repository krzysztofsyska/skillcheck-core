import Link from "next/link";
import { register } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
import { LEGAL_ACCEPTANCE_FIELD, LEGAL_ACCEPTANCE_VALUE } from "../../lib/legal";
import { MARKETING_CONSENT_FIELD, MARKETING_CONSENT_TEXT, MARKETING_CONSENT_VALUE } from "../../lib/marketing-consent";
import { SiteFooter } from "../components/marketing/site-footer";
import { safeNextPath, withNext } from "../../lib/safe-next-path";
export default async function Register({ searchParams }: { searchParams: Promise<{ message?: string; next?: string }> }) {
  const { message, next: nextParam } = await searchParams;
  // Only an internal path survives validation, so no open redirect is possible.
  const next = safeNextPath(nextParam);
  return <><main><section className="auth"><Link href="/" className="eyebrow">SKILLCHECK</Link><h1>Utwórz konto</h1>
    <p>Zacznij od konta. Po potwierdzeniu e-maila skonfigurujesz firmę. Link z wiadomości otwórz w tej samej przeglądarce.</p>
    {message && <p role="alert" className="notice">{message === "invalid" ? "Podaj poprawny e-mail i hasło mające co najmniej 12 znaków." : message === "terms" ? "Aby utworzyć konto, zaakceptuj Regulamin wraz z Umową powierzenia danych i potwierdź zapoznanie się z Polityką prywatności." : message === 'unavailable' ? 'Rejestracja pod tym adresem jest chwilowo niedostępna. Administrator musi sprawdzić konfigurację adresu aplikacji.' : "Nie udało się utworzyć konta. Spróbuj ponownie za chwilę lub zaloguj się, jeśli masz już konto."}</p>}
    <form action={register}>
      {next && <input type="hidden" name="next" value={next} />}
      <label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
      <label>Hasło<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} aria-describedby="password-help" /></label>
      <small id="password-help">Co najmniej 12 znaków.</small>
      <label className="consent"><input type="checkbox" name={LEGAL_ACCEPTANCE_FIELD} value={LEGAL_ACCEPTANCE_VALUE} required />
        <span>Akceptuję <Link href="/regulamin" target="_blank">Regulamin</Link> wraz z <Link href="/regulamin/umowa-powierzenia" target="_blank">Umową powierzenia przetwarzania danych (DPA)</Link> oraz potwierdzam zapoznanie się z <Link href="/polityka-prywatnosci" target="_blank">Polityką prywatności</Link>. Działam w imieniu firmy i jestem do tego upoważniony/a.</span></label>
      {/* SC-CONSENT-001: a SEPARATE, unticked, optional consent. It carries no
          `required` attribute and is never bundled with the Regulamin above, so
          it cannot become a condition of registering. The wording below is the
          text the database stores with the consent event. */}
      <label className="consent"><input type="checkbox" name={MARKETING_CONSENT_FIELD} value={MARKETING_CONSENT_VALUE} />
        <span>{MARKETING_CONSENT_TEXT}</span></label>
      <small>Zgoda na kontakt handlowy jest nieobowiązkowa — konto utworzysz bez jej zaznaczenia.</small>
      <SubmitButton>Utwórz konto</SubmitButton>
    </form><p>Masz już konto? <Link href={withNext("/login", next)}>Zaloguj się</Link></p>
  </section></main><SiteFooter /></>;
}
