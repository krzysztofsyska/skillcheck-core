// SC-020-A — konfiguracja marki firmy (white-label). Czyste funkcje: walidacja
// konfiguracji, kontrast WCAG i walidacja plików. Te same reguły egzekwuje baza
// (private.brand_validate_config w 20261109190000_sc020_brand_configuration.sql);
// baza jest ostateczną granicą, ten moduł daje czytelne komunikaty i chroni
// serwowanie plików.

export const BRAND_ASSET_BUCKET = 'brand-assets';
export const BRAND_ASSET_KINDS = ['logo', 'favicon'] as const;
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number];
export type BrandMime = 'image/png' | 'image/svg+xml' | 'image/x-icon' | 'image/webp';

/** Limity rozmiaru: logo 512 KB, favicon 128 KB (decyzja techniczna SC-020-A). */
export const BRAND_ASSET_LIMITS: Record<BrandAssetKind, number> = { logo: 512 * 1024, favicon: 128 * 1024 };
const ALLOWED: Record<BrandAssetKind, readonly BrandMime[]> = {
  logo: ['image/png', 'image/svg+xml', 'image/webp'],
  favicon: ['image/png', 'image/svg+xml', 'image/x-icon', 'image/webp'],
};
export const BRAND_MIME_EXTENSION: Record<BrandMime, string> = {
  'image/png': 'png', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/webp': 'webp',
};
/** Największy dopuszczalny wymiar obrazu PNG (px). */
export const BRAND_MAX_DIMENSION = 4096;

export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_UI_CONTRAST = 3;

export type BrandColors = { primary: string; onPrimary: string; background: string; text: string; accent: string };
export type BrandConfig = {
  brandName: string;
  colors: BrandColors;
  recruiterPanel: { headerStyle: 'primary' | 'light' };
  candidatePanel: { headline: string; intro: string };
};

export const DEFAULT_BRAND_CONFIG: BrandConfig = {
  brandName: 'Twoja firma',
  colors: { primary: '#1f3a5f', onPrimary: '#ffffff', background: '#ffffff', text: '#1b2433', accent: '#8a4b08' },
  recruiterPanel: { headerStyle: 'primary' },
  candidatePanel: { headline: 'Zadanie rekrutacyjne', intro: '' },
};

export type BrandResult<T> = { ok: true; value: T } | { ok: false; error: string };

const HEX = /^#[0-9a-f]{6}$/;
const COLOR_KEYS = ['accent', 'background', 'onPrimary', 'primary', 'text'] as const;
const COLOR_LABELS: Record<keyof BrandColors, string> = {
  primary: 'kolor główny', onPrimary: 'kolor tekstu na kolorze głównym', background: 'kolor tła',
  text: 'kolor tekstu', accent: 'kolor akcentu',
};
// eslint-disable-next-line no-control-regex
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f<>]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/** Normalizuje kolor do postaci #rrggbb (małe litery). Akceptuje też #rgb. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(raw)) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  return HEX.test(raw) ? raw : null;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
/** Współczynnik kontrastu WCAG 2.x (1–21). */
export function contrastRatio(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export type ContrastCheck = { label: string; ratio: number; minimum: number; ok: boolean };
export function contrastChecks(colors: BrandColors): ContrastCheck[] {
  const check = (label: string, a: string, b: string, minimum: number) => {
    const ratio = contrastRatio(a, b);
    return { label, ratio: Math.round(ratio * 100) / 100, minimum, ok: ratio >= minimum };
  };
  return [
    check('Tekst na tle', colors.text, colors.background, MIN_TEXT_CONTRAST),
    check('Tekst na kolorze głównym', colors.onPrimary, colors.primary, MIN_TEXT_CONTRAST),
    check('Kolor główny na tle (linki, przyciski)', colors.primary, colors.background, MIN_UI_CONTRAST),
    check('Akcent na tle', colors.accent, colors.background, MIN_UI_CONTRAST),
  ];
}

function text(value: unknown, label: string, min: number, max: number): BrandResult<string> {
  if (typeof value !== 'string') return { ok: false, error: `${label}: wymagany tekst.` };
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    return { ok: false, error: min === 0 ? `${label}: najwyżej ${max} znaków.` : `${label}: od ${min} do ${max} znaków.` };
  }
  if (FORBIDDEN_TEXT.test(trimmed)) return { ok: false, error: `${label}: niedozwolone znaki (np. < > lub znaki sterujące).` };
  return { ok: true, value: trimmed };
}

/** Waliduje i normalizuje konfigurację marki. Odrzuca nieznane pola. */
export function parseBrandConfig(input: unknown): BrandResult<BrandConfig> {
  if (!isPlainObject(input) || !sameKeys(input, ['brandName', 'colors', 'recruiterPanel', 'candidatePanel'])) {
    return { ok: false, error: 'Nieprawidłowa konfiguracja marki.' };
  }
  const brandName = text(input.brandName, 'Nazwa marki', 1, 80);
  if (!brandName.ok) return brandName;
  if (!isPlainObject(input.colors) || !sameKeys(input.colors, COLOR_KEYS)) return { ok: false, error: 'Nieprawidłowe kolory.' };
  const colors = {} as BrandColors;
  for (const key of COLOR_KEYS) {
    const value = normalizeHex(input.colors[key]);
    if (!value) return { ok: false, error: `Nieprawidłowy ${COLOR_LABELS[key]} — użyj zapisu #RRGGBB.` };
    colors[key] = value;
  }
  const failed = contrastChecks(colors).find(item => !item.ok);
  if (failed) {
    return { ok: false, error: `Za słaby kontrast: ${failed.label} (${failed.ratio}:1, wymagane co najmniej ${failed.minimum}:1).` };
  }
  const recruiter = input.recruiterPanel;
  if (!isPlainObject(recruiter) || !sameKeys(recruiter, ['headerStyle'])
    || (recruiter.headerStyle !== 'primary' && recruiter.headerStyle !== 'light')) {
    return { ok: false, error: 'Nieprawidłowy wygląd panelu rekrutera.' };
  }
  const candidate = input.candidatePanel;
  if (!isPlainObject(candidate) || !sameKeys(candidate, ['headline', 'intro'])) {
    return { ok: false, error: 'Nieprawidłowy wygląd panelu kandydata.' };
  }
  const headline = text(candidate.headline, 'Nagłówek panelu kandydata', 1, 120);
  if (!headline.ok) return headline;
  const intro = text(candidate.intro, 'Wstęp panelu kandydata', 0, 600);
  if (!intro.ok) return intro;
  return { ok: true, value: {
    brandName: brandName.value, colors,
    recruiterPanel: { headerStyle: recruiter.headerStyle },
    candidatePanel: { headline: headline.value, intro: intro.value },
  } };
}

/** Odczyt konfiguracji z formularza edytora. */
export function brandConfigFromForm(form: FormData): BrandResult<BrandConfig> {
  const get = (name: string) => { const v = form.get(name); return typeof v === 'string' ? v : ''; };
  return parseBrandConfig({
    brandName: get('brandName'),
    colors: { primary: get('primary'), onPrimary: get('onPrimary'), background: get('background'), text: get('text'), accent: get('accent') },
    recruiterPanel: { headerStyle: get('headerStyle') },
    candidatePanel: { headline: get('headline'), intro: get('intro') },
  });
}

/** Zmienne CSS z zatwierdzonej konfiguracji (tylko zwalidowane #rrggbb). */
export function brandCssVariables(config: BrandConfig): Record<string, string> {
  const c = config.colors;
  for (const key of COLOR_KEYS) if (!HEX.test(c[key])) throw new Error('Nieprawidłowy kolor marki.');
  return {
    '--brand-primary': c.primary, '--brand-on-primary': c.onPrimary, '--brand-background': c.background,
    '--brand-text': c.text, '--brand-accent': c.accent,
  };
}

// ---------------------------------------------------------------------------
// Pliki marki

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  Array.from(bytes.subarray(offset, offset + length), b => String.fromCharCode(b)).join('');

function sniff(bytes: Uint8Array): BrandMime | 'svg-candidate' | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 22) return 'image/x-icon';
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return 'svg-candidate';
}

function validatePng(bytes: Uint8Array): string | null {
  // IHDR musi być pierwszym blokiem; wymiary w bajtach 16–23.
  if (bytes.length < 33 || ascii(bytes, 12, 4) !== 'IHDR') return 'Uszkodzony plik PNG.';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > BRAND_MAX_DIMENSION || height > BRAND_MAX_DIMENSION) {
    return `Obraz PNG musi mieć wymiary od 1 do ${BRAND_MAX_DIMENSION} px.`;
  }
  return null;
}

function validateWebp(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(4, true) + 8;
  if (declared !== bytes.length) return 'Uszkodzony plik WebP.';
  if (!['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4))) return 'Uszkodzony plik WebP.';
  return null;
}

function validateIco(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (count < 1 || count > 32 || bytes.length < 6 + count * 16) return 'Uszkodzony plik ICO.';
  for (let i = 0; i < count; i++) {
    const size = view.getUint32(6 + i * 16 + 8, true);
    const offset = view.getUint32(6 + i * 16 + 12, true);
    if (!size || offset < 6 + count * 16 || offset + size > bytes.length) return 'Uszkodzony plik ICO.';
  }
  return null;
}

/**
 * SVG jest odrzucany (nie „czyszczony”), jeśli zawiera cokolwiek, co może
 * wykonać kod, wczytać zasób z zewnątrz albo zmienić parser: skrypty,
 * foreignObject, atrybuty zdarzeń (on*), odwołania href/xlink:href poza
 * kotwicami w tym samym pliku, url() poza kotwicami, @import, DOCTYPE/ENTITY,
 * instrukcje przetwarzania (poza deklaracją XML), CDATA, osadzanie
 * (iframe/embed/object/image/audio/video), animacje zmieniające atrybuty
 * (set/animate) oraz schematy javascript:/data:/vbscript:.
 */
export function svgProblems(source: string): string[] {
  const problems: string[] = [];
  const lower = source.toLowerCase();
  const rule = (ok: boolean, message: string) => { if (!ok) problems.push(message); };
  const withoutDecl = lower.replace(/^﻿?\s*<\?xml[^?]*\?>/, '');
  rule(/^\s*(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(withoutDecl), 'Plik nie zaczyna się od elementu <svg>.');
  rule(!/<\?/.test(withoutDecl), 'Instrukcje przetwarzania XML są niedozwolone.');
  rule(!/<!doctype|<!entity/.test(lower), 'DOCTYPE i ENTITY są niedozwolone.');
  rule(!/<!\[cdata\[/.test(lower), 'Sekcje CDATA są niedozwolone.');
  rule(!/<\s*script/.test(lower), 'Skrypty są niedozwolone.');
  rule(!/<\s*foreignobject/.test(lower), 'Element foreignObject jest niedozwolony.');
  rule(!/<\s*(iframe|embed|object|image|img|audio|video|use|a|set|animate|animatemotion|animatetransform|handler|listener|feimage)[\s/>]/.test(lower),
    'Osadzone zasoby, odnośniki i animacje są niedozwolone.');
  rule(!/[\s/"']on[a-z]+\s*=/.test(lower), 'Atrybuty zdarzeń (on…) są niedozwolone.');
  rule(!/(javascript|vbscript|data)\s*:/.test(lower.replace(/xmlns(:[a-z]+)?\s*=\s*("[^"]*"|'[^']*')/g, '')),
    'Schematy javascript:, vbscript: i data: są niedozwolone.');
  rule(!/@import/.test(lower), '@import jest niedozwolony.');
  for (const match of Array.from(lower.matchAll(/(?:^|[\s"'])(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g))) {
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!/^#[a-z0-9_-]+$/.test(value)) { problems.push('Odwołania do zasobów spoza pliku są niedozwolone.'); break; }
  }
  for (const match of Array.from(lower.matchAll(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/g))) {
    if (!/^#[a-z0-9_-]+$/.test(match[2].trim())) { problems.push('url() może wskazywać tylko na elementy tego pliku.'); break; }
  }
  return Array.from(new Set(problems));
}

function decodeSvg(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type ValidatedAsset = { mime: BrandMime; extension: string; size: number };

/**
 * Waliduje plik marki po zawartości (nie po nazwie ani typie podanym przez
 * przeglądarkę). Używane przed zapisem i przy każdym serwowaniu.
 */
export function validateBrandAsset(bytes: Uint8Array, kind: BrandAssetKind): BrandResult<ValidatedAsset> {
  if (!BRAND_ASSET_KINDS.includes(kind)) return { ok: false, error: 'Nieznany rodzaj pliku.' };
  if (!bytes.length) return { ok: false, error: 'Plik jest pusty.' };
  if (bytes.length > BRAND_ASSET_LIMITS[kind]) {
    return { ok: false, error: `Plik jest za duży (limit ${BRAND_ASSET_LIMITS[kind] / 1024} KB).` };
  }
  let mime = sniff(bytes);
  let problem: string | null = null;
  if (mime === 'svg-candidate') {
    const source = decodeSvg(bytes);
    if (source === null) return { ok: false, error: 'Dozwolone formaty: PNG, SVG, ICO, WebP.' };
    if (!/<svg[\s>]/i.test(source)) return { ok: false, error: 'Dozwolone formaty: PNG, SVG, ICO, WebP.' };
    const problems = svgProblems(source);
    if (problems.length) return { ok: false, error: `Plik SVG odrzucony: ${problems[0]}` };
    mime = 'image/svg+xml';
  } else if (mime === 'image/png') problem = validatePng(bytes);
  else if (mime === 'image/webp') problem = validateWebp(bytes);
  else if (mime === 'image/x-icon') problem = validateIco(bytes);
  if (problem) return { ok: false, error: problem };
  if (!mime || !ALLOWED[kind].includes(mime)) {
    return { ok: false, error: kind === 'logo' ? 'Logo: dozwolone PNG, SVG lub WebP.' : 'Favicon: dozwolone PNG, SVG, ICO lub WebP.' };
  }
  return { ok: true, value: { mime, extension: BRAND_MIME_EXTENSION[mime], size: bytes.length } };
}

/** Ścieżka obiektu w Storage: <company>/<kind>/<uuid>.<ext> (zgodna z polityką RLS). */
export function brandObjectPath(companyId: string, kind: BrandAssetKind, objectId: string, extension: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!uuid.test(companyId) || !uuid.test(objectId) || !BRAND_ASSET_KINDS.includes(kind)
    || !Object.values(BRAND_MIME_EXTENSION).includes(extension)) throw new Error('Nieprawidłowa ścieżka pliku marki.');
  return `${companyId}/${kind}/${objectId}.${extension}`;
}

/** Nagłówki odpowiedzi przy serwowaniu pliku marki. */
export function brandAssetHeaders(mime: BrandMime, size: number): Record<string, string> {
  return {
    'content-type': mime,
    'content-length': String(size),
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'content-disposition': 'inline',
    'referrer-policy': 'no-referrer',
  };
}

/** Czy white-label jest włączony w tym środowisku (domyślnie: tylko Preview/dev). */
export function brandingEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.WHITE_LABEL_ENABLED === 'true') return true;
  if (env.WHITE_LABEL_ENABLED === 'false') return false;
  return env.VERCEL_ENV === 'preview' || env.NODE_ENV === 'development';
}
