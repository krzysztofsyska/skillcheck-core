import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "../../components/marketing/site-header";
import { SiteFooter } from "../../components/marketing/site-footer";
import { CvPoolSlider } from "../../components/pricing/cv-pool-slider";
import styles from "../../marketing.module.css";
import { createClient } from "../../../lib/supabase/server";
import { sliderPackagesFromRows } from "../../../lib/pricing/cv-pool-slider-model.ts";

// Wyłączone domyślnie: bez PRICING_CV_SLIDER_ENABLED=true strona nie istnieje
// (404), więc klienci nic nie widzą, dopóki publiczny cennik (W3/W4) nie ruszy.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Pula CV w pakiecie — SkillCheck",
  robots: { index: false, follow: false },
};

export default async function CvPoolSliderPage() {
  if (process.env.PRICING_CV_SLIDER_ENABLED !== "true") notFound();
  let packages: ReturnType<typeof sliderPackagesFromRows> = null;
  try {
    const { data, error } = await (await createClient()).rpc("pricing_published_packages");
    packages = error ? null : sliderPackagesFromRows(data);
  } catch { packages = null; }
  return <main className={styles.page}>
    <SiteHeader />
    <div id="tresc" className={styles.wrap}>
      <section aria-labelledby="cv-pool-title">
        <h1 id="cv-pool-title">Ile CV chcesz przeanalizować?</h1>
        <p className={styles.lede}>Pulę CV zmieniasz suwakiem albo wpisując liczbę. Cena zawsze pochodzi z aktualnego cennika, a wartość spoza zakresu poprawiamy do najbliższej dozwolonej.</p>
        {packages && packages.length > 0
          ? packages.map(pkg => <CvPoolSlider key={pkg.code} pkg={pkg} />)
          : <p role="alert">Cennik jest chwilowo niedostępny. Spróbuj ponownie później.</p>}
      </section>
    </div>
    <SiteFooter />
  </main>;
}
