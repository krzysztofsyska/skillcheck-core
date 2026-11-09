// SC-020-A — wygląd panelu w marce klienta. Tylko marka klienta; stopka z
// informacjami wymaganymi prawem jest stała i nie pochodzi z konfiguracji.
import type { CSSProperties, ReactNode } from 'react';
import { brandCssVariables, type BrandConfig } from '../../../lib/brand-config';
import { COMPANY } from '../../../lib/legal';
import styles from './brand-frame.module.css';

export function LegalNotice({ controllerName }: { controllerName: string }) {
  return <p className={styles.legal} data-legal-notice="">
    Administratorem danych osobowych kandydatów jest {controllerName}. Operatorem platformy technicznej
    jest {COMPANY.name}, {COMPANY.address}, KRS {COMPANY.krs}, NIP {COMPANY.nip}.{' '}
    <a href="/polityka-prywatnosci">Informacje o przetwarzaniu danych</a>
  </p>;
}

export function BrandHeader({ config, logoHref, homeHref }: { config: BrandConfig; logoHref: string | null; homeHref: string }) {
  return <header className={config.recruiterPanel.headerStyle === 'primary' ? styles.headerPrimary : styles.headerLight}>
    <a className={styles.brand} href={homeHref}>
      {logoHref && <img className={styles.logo} src={logoHref} alt="" height={36} />}
      <span>{config.brandName}</span>
    </a>
  </header>;
}

export function BrandFrame({ config, logoHref, homeHref, controllerName, children }: {
  config: BrandConfig; logoHref: string | null; homeHref: string; controllerName: string; children: ReactNode;
}) {
  return <div className={styles.frame} style={brandCssVariables(config) as CSSProperties} data-brand-frame="">
    <BrandHeader config={config} logoHref={logoHref} homeHref={homeHref} />
    {children}
    <footer className={styles.footer}><LegalNotice controllerName={controllerName} /></footer>
  </div>;
}

/** Podgląd panelu kandydata z bieżącej konfiguracji (szkic lub wersja). */
export function CandidatePanelPreview({ config, logoHref, controllerName }: {
  config: BrandConfig; logoHref: string | null; controllerName: string;
}) {
  return <div className={styles.candidate} style={brandCssVariables(config) as CSSProperties} data-candidate-preview="">
    <div className={styles.candidateBar}>
      {logoHref && <img className={styles.logo} src={logoHref} alt="" height={32} />}
      <strong>{config.brandName}</strong>
    </div>
    <div className={styles.candidateBody}>
      <h3>{config.candidatePanel.headline}</h3>
      {config.candidatePanel.intro && <p>{config.candidatePanel.intro}</p>}
      <p className={styles.accent}>Czas na odpowiedź: 30 minut</p>
      <span className={styles.button} role="presentation">Rozpocznij zadanie</span>
      <LegalNotice controllerName={controllerName} />
    </div>
  </div>;
}
