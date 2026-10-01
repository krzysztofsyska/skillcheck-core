export function appOrigin() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : undefined);
  if (!configured) {
    if (process.env.NODE_ENV === "development") return "http://localhost:3000";
    throw new Error("Brak adresu aplikacji dla wiadomości e-mail.");
  }
  const url = new URL(configured);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Nieprawidłowy adres aplikacji.");
  return url.origin;
}
export function callbackDestination(flow: string | null) {
  return flow === "recovery" ? "/reset-password" : "/dashboard";
}
