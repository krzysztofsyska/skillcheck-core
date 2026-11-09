// SC-020-C — wiadomości do kandydatów w marce klienta (white-label).
//
// Czyste funkcje: z opublikowanej konfiguracji marki (lub bez niej) i danych
// wiadomości budują temat, treść tekstową i HTML. Zasady:
//  - w treści i temacie wyłącznie marka klienta (bez przełącznika na SkillCheck);
//  - stopka prawna (administrator danych = firma klienta, operator platformy,
//    informacja o prawach i o tym, że decyzję podejmuje człowiek) jest STAŁA:
//    nie pochodzi z konfiguracji marki ani z danych wiadomości i nie da się jej
//    zmienić ani pominąć;
//  - nic tu nie wysyła: wysyłka idzie wyłącznie przez BrandMessageTransport,
//    którego jedyna implementacja w kodzie odmawia wysyłki (disabledTransport);
//  - dane wejściowe są walidowane, HTML jest escapowany, kolory pochodzą tylko
//    ze zwalidowanej konfiguracji (#rrggbb), linki tylko https.
import { COMPANY } from './legal.ts';
import { parseBrandConfig, type BrandConfig } from './brand-config.ts';

export const BRAND_MESSAGE_KINDS = ['competency_invitation', 'application_received', 'process_closed'] as const;
export type BrandMessageKind = (typeof BRAND_MESSAGE_KINDS)[number];

export const BRAND_MESSAGE_LABELS: Record<BrandMessageKind, string> = {
  competency_invitation: 'Zaproszenie do zadania rekrutacyjnego',
  application_received: 'Potwierdzenie otrzymania zgłoszenia',
  process_closed: 'Zakończenie procesu rekrutacji',
};

export type BrandMessageInput = {
  kind: BrandMessageKind;
  /** Nazwa firmy klienta z rejestru firm — administrator danych kandydatów. */
  controllerName: string;
  /** Opublikowana konfiguracja marki albo null (wtedy neutralny wygląd). */
  brand: BrandConfig | null;
  positionTitle: string;
  candidateFirstName?: string | null;
  /** Wymagany dla zaproszenia: link https do zadania. */
  actionUrl?: string | null;
  /** Wymagany dla zaproszenia: termin rozpoczęcia (ISO). */
  deadline?: string | null;
};

export type BrandMessage = {
  kind: BrandMessageKind;
  /** Nazwa wyświetlana nadawcy. Adres nadawcy ustala transport (SC-020-B/D). */
  senderName: string;
  subject: string;
  text: string;
  html: string;
  /** Stała stopka prawna (tekst), dołączona do text i html bez zmian. */
  legalFooter: string;
};

export type BrandMessageResult = { ok: true; value: BrandMessage } | { ok: false; error: string };

// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/;
const NEUTRAL_COLORS = { primary: '#1f3a5f', onPrimary: '#ffffff', background: '#ffffff', text: '#1b2433', accent: '#8a4b08' };

function cleanText(value: unknown, label: string, max: number, required: boolean): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${label}: wymagane.`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label}: wymagany tekst.`);
  const trimmed = value.trim();
  if ((required && !trimmed) || Array.from(trimmed).length > max) throw new Error(`${label}: od 1 do ${max} znaków.`);
  if (UNSAFE_TEXT.test(trimmed)) throw new Error(`${label}: niedozwolone znaki.`);
  return trimmed;
}

function cleanUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Link: wymagany adres https.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Link: wymagany adres https.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Link: wymagany adres https.');
  return url.href;
}

function cleanDeadline(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Termin: wymagana data.');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Termin: wymagana data.');
  return date.toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'long', timeStyle: 'short' });
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Stała stopka prawna. Zależy wyłącznie od nazwy administratora i danych operatora z lib/legal.ts. */
export function legalFooterLines(controllerName: string): string[] {
  const controller = cleanText(controllerName, 'Administrator danych', 200, true);
  return [
    `Administratorem Twoich danych osobowych w tej rekrutacji jest ${controller}${controller.endsWith('.') ? '' : '.'}`,
    `Operatorem platformy technicznej jest ${COMPANY.name}, ${COMPANY.address}, KRS ${COMPANY.krs}, NIP ${COMPANY.nip}.`,
    'Masz prawo dostępu do swoich danych, ich sprostowania, usunięcia lub ograniczenia przetwarzania oraz wniesienia skargi do Prezesa UODO. Aby skorzystać z tych praw, odpowiedz na tę wiadomość albo skontaktuj się z administratorem.',
    'Decyzje w rekrutacji podejmują ludzie. Narzędzia pomocnicze nie podejmują decyzji o zatrudnieniu ani o odrzuceniu kandydatury.',
  ];
}

function body(input: BrandMessageInput, brandName: string, position: string, greeting: string) {
  switch (input.kind) {
    case 'competency_invitation': {
      const url = cleanUrl(input.actionUrl);
      const deadline = cleanDeadline(input.deadline);
      return {
        subject: `${brandName}: zaproszenie do zadania rekrutacyjnego — ${position}`,
        paragraphs: [greeting,
          `dziękujemy za udział w rekrutacji na stanowisko ${position}. Zapraszamy Cię do wykonania krótkiego zadania rekrutacyjnego.`,
          `Zadanie możesz rozpocząć do ${deadline}. Po rozpoczęciu zobaczysz czas przeznaczony na odpowiedź.`],
        action: { label: 'Rozpocznij zadanie', url },
        closing: ['Link jest przeznaczony tylko dla Ciebie — nie przekazuj go innym osobom.', `Pozdrawiamy,\n${brandName}`],
      };
    }
    case 'application_received':
      return {
        subject: `${brandName}: otrzymaliśmy Twoje zgłoszenie — ${position}`,
        paragraphs: [greeting, `dziękujemy za zgłoszenie na stanowisko ${position}. Twoja kandydatura została zapisana i jest rozpatrywana.`,
          'Odezwiemy się, gdy będziemy gotowi przedstawić kolejne kroki.'],
        action: null,
        closing: [`Pozdrawiamy,\n${brandName}`],
      };
    case 'process_closed':
      return {
        subject: `${brandName}: rekrutacja na stanowisko ${position} została zakończona`,
        paragraphs: [greeting, `dziękujemy za udział w rekrutacji na stanowisko ${position} i za poświęcony czas.`,
          'Proces rekrutacji na to stanowisko został zakończony. Decyzję podjął zespół rekrutacyjny.'],
        action: null,
        closing: [`Pozdrawiamy,\n${brandName}`],
      };
    default:
      throw new Error('Nieznany rodzaj wiadomości.');
  }
}

/** Buduje wiadomość. Nigdy jej nie wysyła. */
export function renderBrandMessage(input: BrandMessageInput): BrandMessageResult {
  try {
    if (!BRAND_MESSAGE_KINDS.includes(input.kind)) throw new Error('Nieznany rodzaj wiadomości.');
    let brand: BrandConfig | null = null;
    if (input.brand) {
      const checked = parseBrandConfig(input.brand);
      if (!checked.ok) throw new Error('Nieprawidłowa konfiguracja marki.');
      brand = checked.value;
    }
    const controller = cleanText(input.controllerName, 'Administrator danych', 200, true);
    // Bez opublikowanej marki nadawcą jest firma klienta (administrator), nie SkillCheck.
    const brandName = brand?.brandName ?? controller;
    const position = cleanText(input.positionTitle, 'Stanowisko', 200, true);
    const first = cleanText(input.candidateFirstName, 'Imię', 80, false);
    const greeting = first ? `Dzień dobry ${first},` : 'Dzień dobry,';
    const content = body(input, brandName, position, greeting);
    const footer = legalFooterLines(controller);
    const colors = brand?.colors ?? NEUTRAL_COLORS;
    const text = [...content.paragraphs, ...(content.action ? [`${content.action.label}: ${content.action.url}`] : []),
      ...content.closing, '—', ...footer].join('\n\n');
    const p = (s: string) => `<p style="margin:0 0 16px;line-height:1.6">${escapeHtml(s).replace(/\n/g, '<br>')}</p>`;
    const button = content.action
      ? `<p style="margin:24px 0"><a href="${escapeHtml(content.action.url)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${colors.primary};color:${colors.onPrimary};font-weight:700;text-decoration:none">${escapeHtml(content.action.label)}</a></p>`
      : '';
    const html = '<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + `<title>${escapeHtml(content.subject)}</title></head>`
      + `<body style="margin:0;background:${colors.background};color:${colors.text};font-family:Arial,sans-serif">`
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">'
      + `<table role="presentation" width="600" style="width:100%;max-width:600px;background:${colors.background};border:1px solid #d7dfea;border-radius:12px">`
      + `<tr><td style="padding:20px 28px;background:${colors.primary};color:${colors.onPrimary};font-size:20px;font-weight:700" data-brand-header="">${escapeHtml(brandName)}</td></tr>`
      + `<tr><td style="padding:28px;font-size:16px">${content.paragraphs.map(p).join('')}${button}${content.closing.map(p).join('')}</td></tr>`
      + `<tr><td style="padding:16px 28px;border-top:1px solid #d7dfea;font-size:12px;line-height:1.5" data-legal-footer="">${footer.map(line => `<p style="margin:0 0 8px">${escapeHtml(line)}</p>`).join('')}</td></tr>`
      + '</table></td></tr></table></body></html>';
    return { ok: true, value: { kind: input.kind, senderName: brandName, subject: content.subject, text, html, legalFooter: footer.join('\n') } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Nie udało się przygotować wiadomości.' };
  }
}

// ---------------------------------------------------------------------------
// Wysyłka

export type BrandMessageDelivery = { status: 'not_sent'; reason: 'transport_disabled' };
export interface BrandMessageTransport {
  send(message: BrandMessage, recipient: string): Promise<BrandMessageDelivery>;
}

/**
 * Jedyny transport w kodzie: nigdy nie wysyła i niczego nie zapisuje.
 * Prawdziwa wysyłka do kandydatów to osobna decyzja właściciela (AGENTS.md:
 * „external candidate contact” wymaga jego zgody).
 */
export const disabledTransport: BrandMessageTransport = {
  async send() {
    return { status: 'not_sent', reason: 'transport_disabled' };
  },
};

/** Przykładowe dane do podglądu w edytorze marki (bez danych prawdziwych kandydatów). */
export function previewMessageInput(kind: BrandMessageKind, brand: BrandConfig | null, controllerName: string): BrandMessageInput {
  return {
    kind, brand, controllerName, positionTitle: 'Specjalista ds. obsługi klienta', candidateFirstName: 'Anna',
    actionUrl: 'https://example.com/zadanie', deadline: '2026-12-01T16:00:00Z',
  };
}
