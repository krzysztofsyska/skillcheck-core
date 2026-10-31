import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../../components/marketing/site-header";
import { SiteFooter } from "../../components/marketing/site-footer";
import styles from "../../marketing.module.css";
import css from "../checkout.module.css";
import { checkoutProduct, formatPln } from "../../../lib/checkout-catalog";
import { resolveCheckoutService } from "../../../lib/p24-checkout-runtime";
import { COMPANY } from "../../../lib/legal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Status płatności | SkillCheck", robots: { index: false }, referrer: "no-referrer" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const VIEW = {
  paid: { cls: css.paid, title: "Płatność przyjęta — dziękujemy!", text: "Potwierdzenie i fakturę VAT wyślemy na adres e-mail podany w zamówieniu. Pakiet uruchomimy po zaksięgowaniu płatności." },
  pending: { cls: css.pending, title: "Czekamy na potwierdzenie płatności", text: "Przelewy24 jeszcze nie potwierdziło płatności. Zwykle trwa to kilka minut. Odśwież stronę za chwilę — nie płać ponownie." },
  failed: { cls: css.failed, title: "Płatność nie powiodła się", text: "Nie pobraliśmy płatności za to zamówienie. Możesz złożyć zamówienie ponownie albo poprosić o fakturę proforma." },
  cancelled: { cls: css.failed, title: "Zamówienie anulowane", text: "To zamówienie zostało anulowane. Możesz złożyć nowe zamówienie." },
  unknown: { cls: css.failed, title: "Nie znaleźliśmy zamówienia", text: "Sprawdź link albo skontaktuj się z nami." },
} as const;

export default async function CheckoutReturnPage({ searchParams }: Props) {
  const params = await searchParams;
  const orderId = typeof params.order === "string" ? params.order.toLowerCase() : "";
  let result: Awaited<ReturnType<NonNullable<ReturnType<typeof resolveCheckoutService>>["status"]>> = null;
  let unavailable = false;
  try {
    const service = resolveCheckoutService();
    if (!service) unavailable = true;
    else result = await service.status(orderId);
  } catch { unavailable = true; }
  const view = unavailable ? VIEW.pending : VIEW[result?.status ?? "unknown"];
  const product = result ? checkoutProduct(result.productCode) : null;
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="return-title">
        <p className={styles.kicker}>SkillCheck / status płatności</p>
        <h1 id="return-title">{view.title}</h1>
        <p className={`${css.status} ${view.cls}`} role="status" data-status={unavailable ? "unavailable" : result?.status ?? "unknown"}>{view.text}</p>
        {result && <table className={css.summary}>
          <tbody>
            <tr><th scope="row">Produkt</th><td>{product?.name ?? result.productCode}</td></tr>
            <tr><th scope="row">Ilość</th><td>{result.quantity}</td></tr>
            <tr><th scope="row">Kwota brutto</th><td>{formatPln(result.amountGross)}</td></tr>
            <tr><th scope="row">Numer zamówienia</th><td><code>{orderId}</code></td></tr>
          </tbody>
        </table>}
        <div className={styles.actions}>
          {result?.status === "pending" && <Link className={styles.primary} href={`/checkout/return?order=${orderId}`}>Odśwież status</Link>}
          {(result?.status === "failed" || result?.status === "cancelled") && <Link className={styles.primary} href="/checkout">Złóż zamówienie ponownie</Link>}
          <Link className={styles.secondary} href="/kontakt">Kontakt</Link>
        </div>
        <p className={styles.note}>Pytania o płatność: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>, <a href={COMPANY.phoneHref}>{COMPANY.phone}</a>.</p>
      </section>
    </div>
    <SiteFooter />
  </main>;
}
