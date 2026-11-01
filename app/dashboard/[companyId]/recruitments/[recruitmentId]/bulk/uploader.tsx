'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  BULK_MAX_ZIP_BYTES, BULK_OCR_UPLOAD_CONCURRENCY, BULK_UPLOAD_CONCURRENCY, bulkFileKind, bulkMayNeedOcr, displayFileName, isIgnoredZipEntry,
  type BulkFileMeta,
} from '../../../../../../lib/cv-bulk';
import { closeBulkUpload, createBulkBatch } from './actions';

type Picked = { name: string; size: number; blob: Blob };
type Props = { companyId: string; recruitmentId: string; recruitmentName: string; available: number; maxFiles: number; maxFileBytes: number; billingHref: string };

/** Files whose content is sent and may need OCR on the server. */
const sendsForOcr = (f: Picked) => bulkMayNeedOcr(bulkFileKind(f.name)) && f.size > 0;

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1).replace('.', ',')} MB`;

export function BulkUploader(props: Props) {
  const router = useRouter();
  const [files, setFiles] = useState<Picked[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [overLimit, setOverLimit] = useState(0);
  const [starting, setStarting] = useState(false);
  // One request key per selected file set: a repeated click or a retry after an error reuses the
  // same batch instead of reserving package slots twice. A new pick gets a new key.
  const requestKey = useRef<string | null>(null);
  const startLock = useRef(false);

  async function pick(list: FileList | null) {
    setProblem(null); setConfirmed(false);
    requestKey.current = null;
    if (!list?.length) { setFiles([]); return; }
    setReading(true);
    const picked: Picked[] = [];
    try {
      for (const file of Array.from(list)) {
        if (file.name.toLowerCase().endsWith('.zip')) {
          if (file.size > BULK_MAX_ZIP_BYTES) throw new Error(`Archiwum ZIP może mieć maksymalnie ${mb(BULK_MAX_ZIP_BYTES)}.`);
          const { default: JSZip } = await import('jszip');
          const zip = await JSZip.loadAsync(file);
          const entries = Object.values(zip.files).filter(e => !e.dir && !isIgnoredZipEntry(e.name));
          if (picked.length + entries.length > props.maxFiles) throw new Error(`Paczka może mieć maksymalnie ${props.maxFiles} plików CV.`);
          let unpacked = 0;
          for (const entry of entries) {
            // Read the declared size from the ZIP directory before inflating, so one highly
            // compressed entry cannot exhaust the tab's memory. Oversized entries stay listed
            // (shown as too big, never uploaded) without being decompressed.
            const declared = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? NaN);
            if (!Number.isFinite(declared) || declared > props.maxFileBytes) {
              picked.push({ name: displayFileName(entry.name), size: Number.isFinite(declared) ? declared : props.maxFileBytes + 1, blob: new Blob([]) });
              continue;
            }
            unpacked += declared;
            if (unpacked > BULK_MAX_ZIP_BYTES) throw new Error(`Archiwum ZIP po rozpakowaniu może mieć maksymalnie ${mb(BULK_MAX_ZIP_BYTES)}.`);
            const blob = await entry.async('blob');
            if (blob.size > props.maxFileBytes) { picked.push({ name: displayFileName(entry.name), size: blob.size, blob: new Blob([]) }); continue; }
            picked.push({ name: displayFileName(entry.name), size: blob.size, blob });
          }
        } else picked.push({ name: displayFileName(file.name), size: file.size, blob: file });
        if (picked.length > props.maxFiles) throw new Error(`Paczka może mieć maksymalnie ${props.maxFiles} plików CV.`);
      }
      // Readable files first, so unsupported or oversized ones never take a package slot from a real CV.
      const usable = (f: Picked) => bulkFileKind(f.name) !== 'other' && f.size <= props.maxFileBytes && f.size > 0;
      setFiles([...picked.filter(usable), ...picked.filter(f => !usable(f))]);
    } catch (error) {
      setFiles([]);
      const message = error instanceof Error ? error.message : '';
      setProblem(/^(Paczka|Archiwum)/.test(message) ? message : 'Nie udało się odczytać archiwum ZIP. Sprawdź, czy plik nie jest uszkodzony lub zabezpieczony hasłem.');
    } finally { setReading(false); }
  }

  const accepted = Math.min(files.length, props.available);
  const surplus = files.length - accepted;
  const unsupported = files.filter(f => bulkFileKind(f.name) === 'other').length;
  const tooBig = files.filter(f => f.size > props.maxFileBytes).length;

  async function start() {
    // Synchronous guard: a second click before React re-renders the disabled button is ignored.
    if (startLock.current) return;
    startLock.current = true;
    setStarting(true);
    setProblem(null);
    requestKey.current ??= crypto.randomUUID();
    const meta: BulkFileMeta[] = files.map(f => ({ name: f.name, kind: bulkFileKind(f.name), size: f.size }));
    let created: Awaited<ReturnType<typeof createBulkBatch>>;
    try { created = await createBulkBatch(props.companyId, props.recruitmentId, requestKey.current, meta); }
    catch { created = { error: 'Nie udało się utworzyć paczki. Sprawdź połączenie i spróbuj ponownie.' }; }
    if (created.error || !created.batchId || !created.items) {
      setProblem(created.error ?? 'Nie udało się utworzyć paczki.');
      startLock.current = false; setStarting(false);
      return;
    }
    setOverLimit(created.overLimit ?? 0);
    const base = `/dashboard/${props.companyId}/recruitments/${props.recruitmentId}/bulk/${created.batchId}`;
    const queue = created.items.filter(i => i.position <= (created.reserved ?? 0));
    const total = queue.length;
    setProgress({ sent: 0, total });
    let sent = 0;
    const upload = async (item: { id: string; position: number }) => {
      const picked = files[item.position - 1];
      for (let attempt = 0; attempt < 3; attempt++) {
        const body = new FormData();
        if (bulkFileKind(picked.name) === 'other') body.set('unsupported', '1');
        else if (picked.size > props.maxFileBytes) body.set('too_large', '1');
        else body.set('file', picked.blob, picked.name);
        try {
          const response = await fetch(`${base}/items/${item.id}`, { method: 'POST', body });
          // 404 (gone) and 401/403 (no write access) will not change on retry.
          if (response.ok || [401, 403, 404].includes(response.status)) break;
        } catch { /* network error: retry */ }
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
      setProgress({ sent: ++sent, total });
    };
    // PDFs and images may need OCR, which the server runs one image at a time: sending several at once
    // would only make them wait and time out. Text files (DOCX/TXT) and rejected files go in parallel.
    const ocrLane = queue.filter(i => sendsForOcr(files[i.position - 1]));
    const textLane = queue.filter(i => !sendsForOcr(files[i.position - 1]));
    const drain = (lane: typeof queue, width: number) => Array.from({ length: width }, async () => {
      while (lane.length) await upload(lane.shift()!);
    });
    try {
      await Promise.all([...drain(ocrLane, BULK_OCR_UPLOAD_CONCURRENCY), ...drain(textLane, BULK_UPLOAD_CONCURRENCY)]);
      await closeBulkUpload(props.companyId, created.batchId);
    } catch {
      // The batch exists either way: its page shows what arrived, and an upload left open is closed
      // by the background pump. Never leave the button stuck on "Tworzę paczkę…".
    } finally {
      router.push(base);
    }
  }

  if (progress) return <section aria-live="polite">
    <h2>Wysyłanie plików</h2>
    <progress max={progress.total || 1} value={progress.sent} /> <p>{progress.sent} z {progress.total}. Nie zamykaj karty do końca wysyłania — analiza działa dalej w tle.</p>
    {overLimit > 0 && <p role="status">{overLimit} plików przekracza pakiet i nie zostanie przetworzonych. <Link href={props.billingHref}>Zamów pakiet PRESELEKCJA</Link> i wgraj je ponownie.</p>}
  </section>;

  return <section>
    <p>Dodaj pliki PDF, DOCX, TXT, JPG lub PNG albo jedno archiwum ZIP. Maksymalnie {props.maxFiles} plików w paczce, każdy do {mb(props.maxFileBytes)}.
      Skany i zdjęcia odczytujemy automatycznie (OCR) na naszym serwerze.</p>
    <label>Pliki CV
      <input type="file" multiple accept=".pdf,.docx,.txt,.jpg,.jpeg,.png,.zip" disabled={reading || starting} onChange={e => pick(e.target.files)} />
    </label>
    {reading && <p role="status">Odczytuję pliki…</p>}
    {problem && <p role="alert">{problem}</p>}
    {files.length > 0 && <section aria-label="Podsumowanie paczki">
      <h2>Podsumowanie przed startem</h2>
      <ul>
        <li>Rekrutacja: <strong>{props.recruitmentName}</strong></li>
        <li>Liczba plików: <strong>{files.length}</strong></li>
        <li>Zostało CV w pakiecie: <strong>{props.available}</strong></li>
        <li>Zostanie przetworzonych: <strong>{accepted}</strong>{surplus > 0 && <> — <strong>{surplus}</strong> poza limitem pakietu nie zostanie przetworzonych</>}</li>
        {unsupported > 0 && <li>{unsupported} plików ma nieobsługiwany format i zostanie oznaczonych jako błąd.</li>}
        {tooBig > 0 && <li>{tooBig} plików przekracza {mb(props.maxFileBytes)} i zostanie oznaczonych jako błąd.</li>}
      </ul>
      {surplus > 0 && <p role="status">Brakuje {surplus} miejsc w pakiecie. <Link href={props.billingHref}>Zamów pakiet PRESELEKCJA</Link>, a nadwyżkę wgrasz w następnej paczce.</p>}
      {props.available === 0 && <p role="alert">Pakiet jest pusty — żaden plik nie zostanie przetworzony.</p>}
      <label className="consent"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
        Potwierdzam wgranie {accepted} CV do tej rekrutacji. Rozumiem, że system automatycznie zakryje imię, nazwisko, e-mail, telefon i linki
        przed analizą AI, ale nie gwarantuje pełnej anonimizacji. Kandydaci zostali poinformowani o przetwarzaniu danych tak jak przy pojedynczym CV.
        Podział na grupy jest propozycją — decyzję o kandydacie podejmuje rekruter.</label>
      <button type="button" disabled={!confirmed || accepted === 0 || starting} onClick={start}>{starting ? 'Tworzę paczkę…' : 'Rozpocznij przetwarzanie'}</button>
      <details><summary>Lista plików</summary><ol>{files.map((f, i) => <li key={i}>{f.name} ({mb(f.size)}){i >= props.available ? ' — poza limitem' : ''}</li>)}</ol></details>
    </section>}
  </section>;
}
