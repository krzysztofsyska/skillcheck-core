// SC-020-C — podgląd wiadomości do kandydatów w marce klienta. Treść HTML jest
// pokazywana w ramce bez uprawnień (sandbox=""): bez skryptów, formularzy i
// dostępu do strony panelu. Dane przykładowe, bez prawdziwych kandydatów.
import type { BrandConfig } from '../../../lib/brand-config';
import { BRAND_MESSAGE_KINDS, BRAND_MESSAGE_LABELS, previewMessageInput, renderBrandMessage } from '../../../lib/brand-messages';

export function BrandMessagePreviews({ brand, controllerName }: { brand: BrandConfig | null; controllerName: string }) {
  return <div data-message-previews="">
    {BRAND_MESSAGE_KINDS.map(kind => {
      const result = renderBrandMessage(previewMessageInput(kind, brand, controllerName));
      return <details key={kind}>
        <summary>{BRAND_MESSAGE_LABELS[kind]}</summary>
        {result.ok ? <>
          <p><strong>Nadawca:</strong> {result.value.senderName}<br /><strong>Temat:</strong> {result.value.subject}</p>
          <iframe title={`Podgląd: ${BRAND_MESSAGE_LABELS[kind]}`} sandbox="" srcDoc={result.value.html} referrerPolicy="no-referrer"
            style={{ width: '100%', maxWidth: 640, height: 560, border: '1px solid #d7dfea', borderRadius: 8, background: '#fff' }} />
        </> : <p className="notice">{result.error}</p>}
      </details>;
    })}
  </div>;
}
