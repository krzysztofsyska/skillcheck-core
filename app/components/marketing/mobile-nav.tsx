"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import styles from "../../marketing.module.css";

type Item = {
  href: string;
  label: string;
  variant?: "primary";
};

export function MobileNav({ links }: { links: Item[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={styles.menu}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Zamknij" : "Menu"}
      </button>
      <nav id={panelId} className={styles.menuPanel} aria-label="Menu" hidden={!open}>
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={link.variant === "primary" ? styles.primary : styles.menuLink}
            onClick={() => setOpen(false)}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
