export function parseCandidate(form: FormData) {
  const value = (key: string) => String(form.get(key) ?? "").trim();
  const first_name = value("first_name"), last_name = value("last_name");
  const email = value("email"), phone = value("phone");
  if (!first_name || !last_name || first_name.length > 100 || last_name.length > 100) throw new Error("Podaj imię i nazwisko (do 100 znaków każde).");
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Podaj poprawny adres e-mail albo pozostaw pole puste.");
  if (phone && (phone.length > 40 || !/^[+\d\s().-]+$/.test(phone) || !/\d/.test(phone))) throw new Error("Podaj poprawny numer telefonu albo pozostaw pole puste.");
  return { first_name, last_name, email: email || null, phone: phone || null };
}
