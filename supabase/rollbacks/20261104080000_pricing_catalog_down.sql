-- Rollback SC-PRICING-W2 (część 1). Odtwarza stan sprzed migracji: katalog cen
-- nie istniał, a strona i kalkulatory czytały własne stałe w kodzie — i nadal
-- czytają, bo ta migracja ich nie przepinała. Usunięcie katalogu nie zmienia
-- więc żadnej ceny widocznej dla klienta ani niczego w ścieżce zakupu SC-019.
begin;
drop function if exists public.pricing_published_addons();
drop function if exists public.pricing_published_packages();
drop table if exists pricing.addon_options;
drop table if exists pricing.package_prices;
drop table if exists pricing.catalog_versions;
drop schema if exists pricing;
commit;
