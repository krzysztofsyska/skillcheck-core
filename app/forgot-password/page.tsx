import Link from "next/link";
import { requestPasswordReset } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
export default async function ForgotPassword({searchParams}:{searchParams:Promise<{message?:string}>}) {
 const {message}=await searchParams;
 return <main><section className="auth"><Link href="/login">← Logowanie</Link><h1>Odzyskaj dostęp</h1>
 <p>Podaj adres e-mail konta. Link otwórz w tej samej przeglądarce.</p>
 {message&&<p role="status" className="notice">{message==="sent"?"Jeśli konto istnieje i może otrzymywać wiadomości, wysłaliśmy instrukcję zmiany hasła.":message==="rate-limit"?"Osiągnięto limit wysyłki wiadomości aplikacji. Spróbuj ponownie później. Nie musisz zakładać nowego konta.":"Nie udało się wysłać instrukcji. Sprawdź adres i spróbuj ponownie później."}</p>}
 <form action={requestPasswordReset}><label>E-mail<input name="email" type="email" autoComplete="email" required maxLength={254}/></label><SubmitButton>Wyślij instrukcję</SubmitButton></form>
 </section></main>;
}
