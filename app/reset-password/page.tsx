import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { changePassword } from "../auth/actions";
import { SubmitButton } from "../components/submit-button";
export default async function ResetPassword({searchParams}:{searchParams:Promise<{message?:string}>}) {
 const client=await createClient();
 const {data:{user}}=await client.auth.getUser();
 if(!user) redirect("/forgot-password?message=expired");
 const {message}=await searchParams;
 return <main><section className="auth"><h1>Ustaw nowe hasło</h1>
 {message&&<p role="alert" className="notice">Nie udało się zmienić hasła. Wpisz co najmniej 12 znaków i takie samo hasło w obu polach.</p>}
 <form action={changePassword}><label>Nowe hasło<input name="password" type="password" minLength={12} maxLength={256} required autoComplete="new-password"/></label><label>Powtórz hasło<input name="confirmation" type="password" minLength={12} maxLength={256} required autoComplete="new-password"/></label><SubmitButton>Zmień hasło</SubmitButton></form>
 <Link href="/dashboard">Wróć do panelu</Link></section></main>;
}
