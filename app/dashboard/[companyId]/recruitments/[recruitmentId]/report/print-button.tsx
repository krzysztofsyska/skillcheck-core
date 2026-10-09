'use client';

export function PrintReportButton() {
  return <button type="button" onClick={() => window.print()}>Drukuj / zapisz PDF</button>;
}
