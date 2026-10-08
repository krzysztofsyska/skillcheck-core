export const sectionLinks = [
  { href: "/#jak-to-dziala", label: "Jak to działa" },
  { href: "/#mozliwosci", label: "Możliwości" },
  { href: "/#pakiety", label: "Pakiety" },
  { href: "/#o-nas", label: "O nas" },
  { href: "/#faq", label: "FAQ" },
] as const;

export const footerLinks = [
  ...sectionLinks,
  { href: "/demo", label: "Przykład" },
  { href: "/login", label: "Zaloguj się" },
  { href: "/register", label: "Utwórz konto" },
  { href: "/rozmowa", label: "Porozmawiajmy o Twojej rekrutacji" },
] as const;
