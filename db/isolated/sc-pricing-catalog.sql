-- SC-PRICING-002 isolated catalog prototype, disposable PostgreSQL 16 ONLY.
-- NOT a Supabase migration; do not run against Preview/Production.
-- No grants to browser roles and NO payment/credit/SC-019 tables.
BEGIN;
CREATE SCHEMA sc_pricing_isolated;
REVOKE ALL ON SCHEMA sc_pricing_isolated FROM PUBLIC;

CREATE TABLE sc_pricing_isolated.scopes (
  id uuid PRIMARY KEY, scope_code text NOT NULL UNIQUE
    CHECK (scope_code ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  locale text NOT NULL CHECK (locale IN ('pl-PL')),
  currency text NOT NULL CHECK (currency = 'PLN'),
  audience text NOT NULL CHECK (audience = 'public'),
  UNIQUE (id, locale, currency, audience)
);

CREATE TABLE sc_pricing_isolated.versions (
  id uuid PRIMARY KEY,
  scope_id uuid NOT NULL REFERENCES sc_pricing_isolated.scopes(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','SUPERSEDED','ARCHIVED')),
  approved boolean NOT NULL DEFAULT false,
  vat_basis_points integer NOT NULL CHECK (vat_basis_points BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, scope_id)
);

CREATE TABLE sc_pricing_isolated.price_rules (
  version_id uuid NOT NULL REFERENCES sc_pricing_isolated.versions(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  method text NOT NULL CHECK (method IN ('fixed','per_unit','volume_tier','bundle')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (version_id, code)
);
COMMENT ON TABLE sc_pricing_isolated.price_rules IS 'Typed rule payload validated again by publishing validator and quote engine; no JS/SQL evaluation';

CREATE TABLE sc_pricing_isolated.packages (
  version_id uuid NOT NULL REFERENCES sc_pricing_isolated.versions(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code IN ('FREE','PRESELEKCJA','WERYFIKACJA','ASSESSMENT_CENTER')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  commercial_status text NOT NULL CHECK (commercial_status IN ('hidden','informational','on_request','purchasable')),
  base_net_minor bigint CHECK (base_net_minor BETWEEN 0 AND 1000000000000),
  cv_included integer NOT NULL CHECK (cv_included BETWEEN 0 AND 100000),
  cv_policy jsonb NOT NULL CHECK (jsonb_typeof(cv_policy) = 'object'),
  cv_rule_code text,
  capability_code text,
  PRIMARY KEY (version_id,code),
  FOREIGN KEY (version_id,cv_rule_code) REFERENCES sc_pricing_isolated.price_rules(version_id,code) ON DELETE RESTRICT
);

CREATE TABLE sc_pricing_isolated.services (
  version_id uuid NOT NULL REFERENCES sc_pricing_isolated.versions(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'addon',
  unit text NOT NULL CHECK (unit IN ('cv','candidate','interview','test','scenario','minute','hour','item')),
  min_quantity integer NOT NULL CHECK (min_quantity BETWEEN 0 AND 100000),
  max_quantity integer NOT NULL CHECK (max_quantity BETWEEN 0 AND 100000),
  quantity_step integer NOT NULL CHECK (quantity_step BETWEEN 1 AND 100000),
  capability_code text,
  technical_status text NOT NULL CHECK (technical_status IN ('planned','prototype','verified')),
  commercial_status text NOT NULL CHECK (commercial_status IN ('hidden','informational','on_request','purchasable')),
  dependencies text[] NOT NULL DEFAULT '{}', exclusions text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0, visible boolean NOT NULL DEFAULT false,
  default_rule_code text,
  PRIMARY KEY(version_id,code),
  CHECK (min_quantity <= max_quantity),
  CHECK (NOT (code = ANY(dependencies)) AND NOT (code = ANY(exclusions))),
  FOREIGN KEY (version_id,default_rule_code) REFERENCES sc_pricing_isolated.price_rules(version_id,code) ON DELETE RESTRICT
);

CREATE TABLE sc_pricing_isolated.package_services (
  version_id uuid NOT NULL,
  package_code text NOT NULL,
  service_code text NOT NULL,
  allowed boolean NOT NULL DEFAULT false,
  visible boolean NOT NULL DEFAULT false,
  included_quantity integer NOT NULL CHECK (included_quantity BETWEEN 0 AND 100000),
  max_quantity integer NOT NULL CHECK (max_quantity BETWEEN 0 AND 100000),
  quantity_step integer NOT NULL CHECK (quantity_step BETWEEN 1 AND 100000),
  extra_allowed boolean NOT NULL DEFAULT false,
  auto_purchase boolean NOT NULL DEFAULT false,
  commercial_status text NOT NULL CHECK (commercial_status IN ('hidden','informational','on_request','purchasable')),
  override_rule_code text,
  PRIMARY KEY (version_id,package_code,service_code),
  FOREIGN KEY (version_id,package_code) REFERENCES sc_pricing_isolated.packages(version_id,code) ON DELETE RESTRICT,
  FOREIGN KEY (version_id,service_code) REFERENCES sc_pricing_isolated.services(version_id,code) ON DELETE RESTRICT,
  FOREIGN KEY (version_id,override_rule_code) REFERENCES sc_pricing_isolated.price_rules(version_id,code) ON DELETE RESTRICT,
  CHECK (included_quantity <= max_quantity),
  CHECK (allowed OR (included_quantity = 0 AND extra_allowed = false AND auto_purchase = false)),
  CHECK (NOT auto_purchase OR allowed)
);

-- Enforce *global* service quantity ceiling and aligned unit step, not merely row CHECK.
CREATE FUNCTION sc_pricing_isolated.check_package_service() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE global_max integer; global_step integer;
BEGIN
  SELECT max_quantity, quantity_step INTO global_max, global_step
  FROM sc_pricing_isolated.services
  WHERE version_id = NEW.version_id AND code = NEW.service_code;
  IF global_max IS NULL OR NEW.max_quantity > global_max OR
     NEW.quantity_step % global_step <> 0 THEN
    RAISE EXCEPTION 'sc_pricing_package_service_limits' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER package_service_limits BEFORE INSERT OR UPDATE
ON sc_pricing_isolated.package_services FOR EACH ROW
EXECUTE FUNCTION sc_pricing_isolated.check_package_service();

-- Snapshot rows become immutable after publication, even if catalog is superseded.
CREATE FUNCTION sc_pricing_isolated.guard_catalog_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_version uuid; new_version uuid;
BEGIN
  old_version := CASE WHEN TG_OP <> 'INSERT' THEN OLD.version_id ELSE NULL END;
  new_version := CASE WHEN TG_OP <> 'DELETE' THEN NEW.version_id ELSE NULL END;
  IF EXISTS (SELECT 1 FROM sc_pricing_isolated.versions v
             WHERE v.id IN (old_version,new_version)
               AND v.status IN ('PUBLISHED','SUPERSEDED')) THEN
    RAISE EXCEPTION 'sc_pricing_published_snapshot_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER rule_immutable BEFORE INSERT OR UPDATE OR DELETE ON sc_pricing_isolated.price_rules
FOR EACH ROW EXECUTE FUNCTION sc_pricing_isolated.guard_catalog_snapshot();
CREATE TRIGGER package_immutable BEFORE INSERT OR UPDATE OR DELETE ON sc_pricing_isolated.packages
FOR EACH ROW EXECUTE FUNCTION sc_pricing_isolated.guard_catalog_snapshot();
CREATE TRIGGER service_immutable BEFORE INSERT OR UPDATE OR DELETE ON sc_pricing_isolated.services
FOR EACH ROW EXECUTE FUNCTION sc_pricing_isolated.guard_catalog_snapshot();
CREATE TRIGGER package_service_immutable BEFORE INSERT OR UPDATE OR DELETE ON sc_pricing_isolated.package_services
FOR EACH ROW EXECUTE FUNCTION sc_pricing_isolated.guard_catalog_snapshot();

CREATE FUNCTION sc_pricing_isolated.guard_version_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' AND OLD.status IN ('PUBLISHED','SUPERSEDED') THEN
   RAISE EXCEPTION 'sc_pricing_version_immutable' USING ERRCODE = '55000';
 END IF;
 IF TG_OP = 'UPDATE' AND OLD.status IN ('PUBLISHED','SUPERSEDED') THEN
   IF (NEW.id,NEW.scope_id,NEW.approved,NEW.vat_basis_points,NEW.created_at)
      IS DISTINCT FROM
      (OLD.id,OLD.scope_id,OLD.approved,OLD.vat_basis_points,OLD.created_at)
      OR (OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED','SUPERSEDED'))
      OR (OLD.status = 'SUPERSEDED' AND NEW.status <> 'SUPERSEDED')
   THEN RAISE EXCEPTION 'sc_pricing_version_immutable' USING ERRCODE = '55000'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER version_history BEFORE UPDATE OR DELETE ON sc_pricing_isolated.versions
FOR EACH ROW EXECUTE FUNCTION sc_pricing_isolated.guard_version_history();

-- Prototype is deny-by-default: no SELECT/INSERT/UPDATE/DELETE policies for browser roles.
ALTER TABLE sc_pricing_isolated.scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.price_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.package_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.versions FORCE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.price_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.packages FORCE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.services FORCE ROW LEVEL SECURITY;
ALTER TABLE sc_pricing_isolated.package_services FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA sc_pricing_isolated FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sc_pricing_isolated FROM PUBLIC;
COMMIT;
