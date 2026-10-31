import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../components/marketing/site-header";
import { SiteFooter } from "../components/marketing/site-footer";
import styles from "../marketing.module.css";
import css from "./checkout.module.css";
import { CHECKOUT_PRODUCTS, checkoutProduct, checkoutQuantity, formatPln } from "../../lib/checkout-catalog";
import { checkoutConfigured } from "../../lib/p24-checkout-runtime";
import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Zamówienie i płatność online | SkillCheck",
  description: "Kup pakiet SkillCheck online. Płatność przez Przelewy24: BLIK, szybki przelew lub karta, bez dodatkowych opłat.",
  robots: { index: false },
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CheckoutPage({ searchParams }: Props) {
  const params = await searchParams;
  const product = checkoutProduct(typeof params.produkt === "string" ? params.produkt : "preselekcja") ?? CHECKOUT_PRODUCTS.preselekcja;
  const quantity = checkoutQuantity(product, typeof params.ilosc === "string" ? params.ilosc : "1") ?? 1;
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="checkout-title">
        <p className={styles.kicker}>SkillCheck / zamówienie</p>
        <h1 id="checkout-title">Zamówienie i płatność online</h1>
        <p className={styles.lede}>Sprawdź zamówienie, podaj dane kupującego i przejdź do bezpiecznej płatności Przelewy24.
          Wolisz przelew tradycyjny? <Link href="/preselekcja">Poproś o fakturę proforma</Link>.</p>
        <CheckoutForm
          product={{ code: product.code, name: product.name, description: product.description, unitGross: product.unitGross, maxQuantity: product.maxQuantity }}
          initialQuantity={quantity}
          enabled={checkoutConfigured()}
        />
        <p className={styles.note}>Ceny zawierają 23% VAT. Fakturę VAT wyślemy na podany adres e-mail po zaksięgowaniu płatności.
          Cena jednostkowa: {formatPln(product.unitGross)} brutto.</p>
      </section>
    </div>
    <SiteFooter />
  </main>;
}
