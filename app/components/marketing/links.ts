export const sectionLinks = [
  { href: "/#jak-to-dziala", label: "Jak to działa" },
  { href: "/#mozliwosci", label: "Możliwości" },
  { href: "/#pakiety", label: "Pakiety" },
  { href: "/#faq", label: "FAQ" },
] as const;

export const footerLinks = [
  ...sectionLinks,
  { href: "/demo", label: "Przykład" },
  { href: "/login", label: "Zaloguj się" },
  { href: "/register", label: "Utwórz konto" },
] as const;
