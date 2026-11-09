import Link from "next/link";
import { notFound } from "next/navigation";
import { companyAccess } from "../../../../lib/company-access";
import {
  BRAND_ASSET_LIMITS, DEFAULT_BRAND_CONFIG, brandingEnabled, contrastChecks, parseBrandConfig, type BrandConfig,
} from "../../../../lib/brand-config";
import { brandAssetHref, loadPublishedBrand } from "../../../../lib/brand-server";
import { BrandHeader, CandidatePanelPreview } from "../../../components/brand/brand-frame";
import { SubmitButton } from "../../../components/submit-button";
import { publishBrandDraft, rollbackBrand, saveBrandDraft, uploadBrandAsset } from "./actions";
import { BrandMessagePreviews } from "../../../components/brand/brand-message-preview";

const messages: Record<string, string> = {
  draft_saved: "Szkic zapisany. Sprawdź podgląd poniżej i opublikuj, gdy wszystko się zgadza.",
  asset_saved: "Plik zapisany. Wybierz go w szkicu i zapisz szkic.",
  published: "Marka opublikowana. Panel firmy wyświetla teraz tę wersję.",
  rolled_back: "Przywrócono wcześniejszą wersję jako nową wersję opublikowaną.",
  invalid: "Nie zapisano szkicu.",
  contrast_insufficient: "Za słaby kontrast kolorów — popraw kolory.",
  color_invalid: "Nieprawidłowy kolor — użyj zapisu #RRGGBB.",
  config_invalid: "Nieprawidłowa konfiguracja.",
  asset_invalid: "Nie przyjęto pliku.",
  asset_limit: "Osiągnięto limit plików marki dla firmy (50 plików). Pliki marki są przechowywane na stałe jako historia; aby zwiększyć limit, skontaktuj się z obsługą.",
  draft_changed: "Szkic zmienił się po wyświetleniu podglądu. Sprawdź podgląd jeszcze raz i opublikuj ponownie.",
  version_unavailable: "Tej wersji nie można przywrócić.",
  forbidden: "Markę może zmieniać tylko właściciel konta firmy.",
  storage_unavailable: "Przechowywanie plików jest niedostępne w tym środowisku.",
  failed: "Nie udało się zapisać zmian. Spróbuj ponownie.",
};

type Version = { id: string; status: string; version_no: number | null; config: unknown; logo_asset_id: string | null;
  favicon_asset_id: string | null; rolled_back_from: string | null; published_at: string | null; updated_at: string };
type EditorState = { draft: Version | null; versions: Version[];
  assets: { id: string; kind: "logo" | "favicon"; mime: string; byte_size: number; created_at: string }[];
  events: { action: string; actor: string; at: string }[] };

const when = (value: string | null) => value ? new Date(value).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "—";
const actionLabels: Record<string, string> = { asset_registered: "dodano plik", draft_saved: "zapisano szkic", published: "opublikowano", rolled_back: "przywrócono wersję" };

export default async function BrandPage({ params, searchParams }: {
  params: Promise<{ companyId: string }>; searchParams: Promise<{ status?: string; message?: string }>;
}) {
  const { companyId } = await params;
  if (!brandingEnabled()) notFound();
  const { client, company, user } = await companyAccess(companyId);
  const { status, message } = await searchParams;
  const notice = status && messages[status] ? `${messages[status]}${message ? ` ${message.slice(0, 300)}` : ""}` : null;
  const isOwner = user.id === company.owner_id;

  if (!isOwner) {
    const brand = await loadPublishedBrand(companyId);
    return <main className="workspace"><section>
      <nav><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link></nav>
      <p className="eyebrow">MARKA FIRMY</p><h1>Wygląd panelu</h1>
      <p className="notice">Wygląd panelu ustawia właściciel konta firmy. Widzisz opublikowaną wersję.</p>
      {brand ? <p>Opublikowana wersja {brand.versionNo}: {brand.config.brandName}.</p> : <p>Firma nie ma jeszcze opublikowanej marki.</p>}
    </section></main>;
  }

  const { data, error } = await client.rpc("brand_editor_state", { target_company: companyId });
  if (error) {
    return <main className="workspace"><section>
      <nav><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link></nav>
      <h1>Wygląd panelu</h1><p className="notice">Konfiguracja marki nie jest jeszcze dostępna w tym środowisku.</p>
    </section></main>;
  }
  const state = data as unknown as EditorState;
  const draftConfig = state.draft ? parseBrandConfig(state.draft.config) : null;
  const config: BrandConfig = draftConfig?.ok ? draftConfig.value : DEFAULT_BRAND_CONFIG;
  const logos = state.assets.filter(a => a.kind === "logo");
  const favicons = state.assets.filter(a => a.kind === "favicon");
  const href = (id: string | null | undefined) => id ? brandAssetHref(companyId, id) : null;
  const published = state.versions.find(v => v.status === "published") ?? null;
  const checks = contrastChecks(config.colors);
  const publishedConfig = published ? parseBrandConfig(published.config) : null;
  const previewBrand: BrandConfig | null = state.draft && draftConfig?.ok ? config : publishedConfig?.ok ? publishedConfig.value : null;

  return <main className="workspace"><section>
    <nav><Link href={`/dashboard/${companyId}`}>← Panel firmy</Link></nav>
    <p className="eyebrow">MARKA FIRMY</p><h1>Wygląd panelu w Twojej marce</h1>
    <p className="lead">Panel rekrutera i panel kandydata pokazują wyłącznie markę Twojej firmy. Informacje wymagane prawem
      (kto jest administratorem danych i kto jest operatorem platformy) zostają zawsze i nie da się ich zmienić.</p>
    {notice && <p className="notice" role="status">{notice}</p>}
    <p>{published ? `Opublikowana wersja: ${published.version_no} (${when(published.published_at)}).` : "Brak opublikowanej wersji — panel wygląda standardowo."}</p>

    <h2>1. Pliki</h2>
    <p>Logo: PNG, SVG lub WebP, do {BRAND_ASSET_LIMITS.logo / 1024} KB. Ikona karty (favicon): PNG, SVG, ICO lub WebP,
      do {BRAND_ASSET_LIMITS.favicon / 1024} KB. Pliki SVG ze skryptami, odnośnikami lub osadzonymi treściami są odrzucane.</p>
    <form action={uploadBrandAsset} encType="multipart/form-data" className="field-grid">
      <input type="hidden" name="companyId" value={companyId} />
      <label>Rodzaj<select name="kind" defaultValue="logo"><option value="logo">Logo</option><option value="favicon">Favicon</option></select></label>
      <label>Plik<input type="file" name="file" required accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,image/webp,.ico" /></label>
      <div><SubmitButton>Wgraj plik</SubmitButton></div>
    </form>

    <h2>2. Szkic</h2>
    <form action={saveBrandDraft}>
      <input type="hidden" name="companyId" value={companyId} />
      <fieldset><legend>Marka</legend>
        <label>Nazwa marki<input name="brandName" required maxLength={80} defaultValue={config.brandName} /></label>
        <div className="field-grid">
          <label>Logo<select name="logo" defaultValue={state.draft?.logo_asset_id ?? ""}><option value="">Bez logo</option>
            {logos.map(a => <option key={a.id} value={a.id}>{`${a.mime.replace("image/", "").toUpperCase()}, ${Math.ceil(a.byte_size / 1024)} KB, ${when(a.created_at)}`}</option>)}</select></label>
          <label>Favicon<select name="favicon" defaultValue={state.draft?.favicon_asset_id ?? ""}><option value="">Domyślna</option>
            {favicons.map(a => <option key={a.id} value={a.id}>{`${a.mime.replace("image/", "").toUpperCase()}, ${Math.ceil(a.byte_size / 1024)} KB, ${when(a.created_at)}`}</option>)}</select></label>
        </div>
      </fieldset>
      <fieldset><legend>Kolory</legend><div className="field-grid">
        {([["primary", "Kolor główny"], ["onPrimary", "Tekst na kolorze głównym"], ["background", "Tło"], ["text", "Tekst"], ["accent", "Akcent"]] as const)
          .map(([name, label]) => <label key={name}>{label}<input type="color" name={name} defaultValue={config.colors[name]} /></label>)}
      </div>
      <ul>{checks.map(c => <li key={c.label}>{c.ok ? "✓" : "✗"} {c.label}: {c.ratio}:1 (minimum {c.minimum}:1)</li>)}</ul>
      </fieldset>
      <fieldset><legend>Panel rekrutera</legend>
        <label>Nagłówek<select name="headerStyle" defaultValue={config.recruiterPanel.headerStyle}>
          <option value="primary">W kolorze głównym</option><option value="light">Jasny</option></select></label>
      </fieldset>
      <fieldset><legend>Panel kandydata</legend>
        <label>Nagłówek<input name="headline" required maxLength={120} defaultValue={config.candidatePanel.headline} /></label>
        <label>Wstęp (opcjonalnie)<textarea name="intro" maxLength={600} rows={3} defaultValue={config.candidatePanel.intro} /></label>
      </fieldset>
      <div className="actions"><SubmitButton>Zapisz szkic</SubmitButton></div>
    </form>

    <h2>3. Podgląd szkicu</h2>
    {state.draft && draftConfig?.ok ? <>
      <p>Tak będzie wyglądał panel po publikacji. Szkic zapisany: {when(state.draft.updated_at)}.</p>
      <h3>Panel rekrutera</h3>
      <div style={{ border: "1px solid #d7dfea", borderRadius: 12, overflow: "hidden", maxWidth: 720 }} data-recruiter-preview="">
        <BrandHeader config={config} logoHref={href(state.draft.logo_asset_id)} homeHref={`/dashboard/${companyId}/marka`} />
      </div>
      <h3>Panel kandydata</h3>
      <CandidatePanelPreview config={config} logoHref={href(state.draft.logo_asset_id)} controllerName={company.name} />
      <form action={publishBrandDraft}>
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="draftId" value={state.draft.id} />
        <input type="hidden" name="draftUpdatedAt" value={state.draft.updated_at} />
        <div className="actions"><SubmitButton>Opublikuj tę wersję</SubmitButton></div>
      </form>
    </> : <p>Zapisz szkic, aby zobaczyć podgląd i móc go opublikować.</p>}

    <h2>Wiadomości do kandydatów (podgląd)</h2>
    <p>Tak będą wyglądały wiadomości do kandydatów w Twojej marce{state.draft && draftConfig?.ok ? " (według szkicu)" : ""}.
      Stopka z informacjami prawnymi jest stała. <strong>Wysyłka jest wyłączona</strong> — nic nie trafia do kandydatów.</p>
    <BrandMessagePreviews brand={previewBrand} controllerName={company.name} />

    <h2>4. Historia wersji</h2>
    {state.versions.length ? <ul className="companies">{state.versions.map(v => {
      const vc = parseBrandConfig(v.config);
      return <li key={v.id}><strong>Wersja {v.version_no}</strong>{v.status === "published" && <span className="badge">Opublikowana</span>}
        <p>{vc.ok ? vc.value.brandName : "—"} · opublikowano {when(v.published_at)}{v.rolled_back_from ? " · przywrócona z wcześniejszej wersji" : ""}</p>
        {v.status === "superseded" && <form action={rollbackBrand}>
          <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="versionId" value={v.id} />
          <SubmitButton>Przywróć tę wersję</SubmitButton></form>}
      </li>;
    })}</ul> : <p>Nic jeszcze nie opublikowano.</p>}

    <h2>Dziennik zmian</h2>
    {state.events.length ? <ul>{state.events.slice(0, 30).map((e, i) => <li key={i}>{when(e.at)} — {actionLabels[e.action] ?? e.action}
      {e.actor === user.id ? " (Ty)" : ` (użytkownik …${e.actor.slice(-6)})`}</li>)}</ul> : <p>Brak zmian.</p>}
  </section></main>;
}
