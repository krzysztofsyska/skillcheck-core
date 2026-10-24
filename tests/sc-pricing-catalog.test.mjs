import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../db/isolated/sc-pricing-catalog.sql', import.meta.url), 'utf8');
const ids = {
  scope: '00000000-0000-4000-8000-000000000401',
  draft: '00000000-0000-4000-8000-000000000402',
  published: '00000000-0000-4000-8000-000000000403',
};
const assertSqlError = (fn, code) => assert.rejects(fn, e => e.code === code || String(e.message).includes(code));

test('catalog prototype is isolated, no real migration or existing SC-019 ledger, RLS denied', () => {
  assert.match(schema, /^-- SC-PRICING-002 isolated catalog prototype/m);
  assert.doesNotMatch(schema, /\b(?:sc19_balances|sc19_credit_journal|sc19_payment_orders|supabase\/migrations)\b/i);
  for (const table of ['scopes', 'versions', 'price_rules', 'packages', 'services', 'package_services']) {
    assert.ok(schema.includes('CREATE TABLE sc_pricing_isolated.' + table));
    assert.ok(schema.includes('ALTER TABLE sc_pricing_isolated.' + table + ' ENABLE ROW LEVEL SECURITY'));
    assert.ok(schema.includes('ALTER TABLE sc_pricing_isolated.' + table + ' FORCE ROW LEVEL SECURITY'));
  }
  assert.doesNotMatch(schema, /CREATE POLICY|GRANT .* TO (?:PUBLIC|authenticated|anon)/i);
});

test('PostgreSQL16 catalog FK, plan overrides, immutability, hostile RLS', async t => {
  const value = process.env.SC_PRICING_TEST_DATABASE_URL;
  if (!value) { t.skip('Required PG16 CI provides disposable postgres loopback URL'); return; }
  const url = new URL(value);
  if (!['127.0.0.1','localhost','::1'].includes(url.hostname) ||
      url.pathname !== '/postgres' || url.username !== 'postgres' ||
      url.password !== 'postgres' || url.port !== '5432') {
    throw new Error('SC_PRICING_TEST_DATABASE_URL must be isolated postgres:postgres@127.0.0.1:5432/postgres');
  }
  const pg = (await import('pg')).default;
  const db = new pg.Client({ connectionString: value });
  await db.connect();
  const role = 'sc_pricing_probe_local';
  const q = (statement, values=[]) => db.query(statement.replaceAll('@', 'sc_pricing_isolated.'), values);
  try {
    await db.query('DROP SCHEMA IF EXISTS sc_pricing_isolated CASCADE');
    await db.query(schema);

    await t.test('one service linked independently to PRESELEKCJA, WERYFIKACJA and AC', async () => {
      await q('INSERT INTO @scopes(id,scope_code,locale,currency,audience) VALUES ($1,$2,$3,$4,$5)',
        [ids.scope,'public_pl','pl-PL','PLN','public']);
      await q('INSERT INTO @versions(id,scope_id,status,vat_basis_points) VALUES ($1,$2,$3,$4),($5,$2,$3,$4)',
        [ids.draft,ids.scope,'DRAFT',2300,ids.published]);
      for (const [code,unitMinor] of [['base_report',500],['pres_report',200],['verify_report',300],['ac_report',150]]) {
        await q('INSERT INTO @price_rules(version_id,code,method,payload) VALUES($1,$2,$3,$4)',
          [ids.draft,code,'per_unit',JSON.stringify({unitMinor})]);
      }
      const cvPolicy=JSON.stringify({quick:[10,20,30],range:{min:35,max:150,step:5}});
      for (const pkg of ['PRESELEKCJA','WERYFIKACJA','ASSESSMENT_CENTER']) {
        await q('INSERT INTO @packages(version_id,code,name,commercial_status,base_net_minor,cv_included,cv_policy) VALUES($1,$2,$2,$3,$4,$5,$6)',
          [ids.draft,pkg,'on_request',null,20,cvPolicy]);
      }
      await q("INSERT INTO @services(version_id,code,name,unit,min_quantity,max_quantity,quantity_step,technical_status,commercial_status,default_rule_code) VALUES($1,'report_ext','Raport rozszerzony','item',0,20,1,'prototype','on_request','base_report')",[ids.draft]);
      for(const [pkg,rule,included] of [['PRESELEKCJA','pres_report',0],['WERYFIKACJA','verify_report',1],['ASSESSMENT_CENTER','ac_report',2]]) {
        await q("INSERT INTO @package_services(version_id,package_code,service_code,allowed,visible,included_quantity,max_quantity,quantity_step,extra_allowed,commercial_status,override_rule_code) VALUES($1,$2,'report_ext',true,true,$3,20,1,true,'on_request',$4)",[ids.draft,pkg,included,rule]);
      }
      const result=await q("SELECT ps.package_code,ps.included_quantity,(r.payload->>'unitMinor')::int AS unit_minor FROM @package_services ps JOIN @price_rules r ON r.version_id=ps.version_id AND r.code=ps.override_rule_code WHERE ps.service_code='report_ext' ORDER BY ps.package_code");
      assert.equal(result.rows.length,3);
      assert.deepEqual(result.rows.map(v=>v.unit_minor).sort((a,b)=>a-b),[150,200,300]);
      assert.equal(new Set(result.rows.map(v=>v.included_quantity)).size,3);
      await assertSqlError(()=>q("INSERT INTO @services(version_id,code,name,unit,min_quantity,max_quantity,quantity_step,technical_status,commercial_status) VALUES($1,'report_ext','Duplicate','item',0,20,1,'prototype','on_request')",[ids.draft]),'23505');
    });

    await t.test('invalid limits and cross-package links fail closed',async()=>{
      await assertSqlError(()=>q("UPDATE @package_services SET included_quantity=25 WHERE version_id=$1 AND package_code='WERYFIKACJA'",[ids.draft]),'23514');
      await assertSqlError(()=>q("UPDATE @package_services SET max_quantity=21 WHERE version_id=$1 AND package_code='WERYFIKACJA'",[ids.draft]),'22023');
      await assertSqlError(()=>q("UPDATE @package_services SET commercial_status='BUYABLE' WHERE version_id=$1 AND package_code='WERYFIKACJA'",[ids.draft]),'23514');
      await assertSqlError(()=>q("INSERT INTO @package_services(version_id,package_code,service_code,included_quantity,max_quantity,quantity_step,commercial_status) VALUES($1,'FREE','report_ext',0,1,1,'hidden')",[ids.draft]),'23503');
      const result=await q('SELECT count(*)::int AS n FROM @package_services WHERE version_id=$1',[ids.draft]);
      assert.equal(result.rows[0].n,3);
    });

    await t.test('rule payloads are typed in the database: v1 methods only, valid tiers',async()=>{
      const ok=[['flat_cv','tiered_flat',{tiers:[{upTo:30,amountMinor:29000},{upTo:50,amountMinor:30000},{upTo:null,amountMinor:32000}]}],
        ['fixed_ok','fixed',{amountMinor:4000}],
        ['grad_ok','volume_tier',{mode:'graduated',tiers:[{upTo:10,unitMinor:100},{upTo:40,unitMinor:50}]}]];
      for (const [code,method,payload] of ok)
        await q('INSERT INTO @price_rules(version_id,code,method,payload) VALUES($1,$2,$3,$4)',[ids.draft,code,method,JSON.stringify(payload)]);
      const bad=[
        ['bundle',{amountMinor:1,covers:[]}],
        ['formula',{expr:'1+1'}],
        ['fixed',{amountMinor:-1}],
        ['fixed',{amountMinor:1.5}],
        ['fixed',{amountMinor:1,unitMinor:2}],
        ['per_unit',{unitMinor:'100'}],
        ['volume_tier',{mode:'stepwise',tiers:[{upTo:null,unitMinor:1}]}],
        ['tiered_flat',{tiers:[]}],
        ['tiered_flat',{tiers:[{upTo:50,amountMinor:1},{upTo:30,amountMinor:2}]}],
        ['tiered_flat',{tiers:[{upTo:null,amountMinor:1},{upTo:30,amountMinor:2}]}],
        ['tiered_flat',{tiers:[{upTo:10.5,amountMinor:1}]}],
        ['tiered_flat',{tiers:[{upTo:10,amountMinor:1,extra:1}]}],
        ['tiered_flat',{tiers:[{upTo:100001,amountMinor:1}]}],
      ];
      for (const [i,[method,payload]] of bad.entries())
        await assertSqlError(()=>q('INSERT INTO @price_rules(version_id,code,method,payload) VALUES($1,$2,$3,$4)',[ids.draft,'bad_'+i,method,JSON.stringify(payload)]),'23514');
    });

    await t.test('plan-service flags follow the contract semantics',async()=>{
      const base="UPDATE @package_services SET %s WHERE version_id=$1 AND package_code='WERYFIKACJA'";
      for (const set of ["auto_purchase=true, commercial_status='on_request'",
                         "allowed=false, included_quantity=0, extra_allowed=false, auto_purchase=false, visible=true",
                         "commercial_status='hidden', visible=true"])
        await assertSqlError(()=>q(base.replace('%s',set),[ids.draft]),'23514');
      await assertSqlError(()=>q("UPDATE @services SET dependencies='{x_dep}', exclusions='{x_dep}' WHERE version_id=$1 AND code='report_ext'",[ids.draft]),'23514');
    });

    await t.test('service limit change cannot miss a concurrently committed assignment (REPEATABLE READ)',async()=>{
      await q("INSERT INTO @services(version_id,code,name,unit,min_quantity,max_quantity,quantity_step,technical_status,commercial_status) VALUES($1,'race_svc','Race','item',0,20,1,'prototype','on_request')",[ids.draft]);
      const other=new pg.Client({connectionString:value});
      await other.connect();
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await db.query('SELECT count(*) FROM sc_pricing_isolated.package_services'); // snapshot taken here
        await other.query("INSERT INTO sc_pricing_isolated.package_services(version_id,package_code,service_code,allowed,visible,included_quantity,max_quantity,quantity_step,extra_allowed,commercial_status) VALUES($1,'PRESELEKCJA','race_svc',true,true,0,20,1,true,'on_request')",[ids.draft]);
        await assertSqlError(()=>db.query("UPDATE sc_pricing_isolated.services SET max_quantity=10 WHERE version_id=$1 AND code='race_svc'",[ids.draft]),'40001');
        await db.query('ROLLBACK');
        // READ COMMITTED sees the committed assignment and rejects the narrowing.
        await assertSqlError(()=>q("UPDATE @services SET max_quantity=10 WHERE version_id=$1 AND code='race_svc'",[ids.draft]),'22023');
        await q("DELETE FROM @package_services WHERE version_id=$1 AND service_code='race_svc'",[ids.draft]);
        await q("DELETE FROM @services WHERE version_id=$1 AND code='race_svc'",[ids.draft]);
      } finally {
        try { await db.query('ROLLBACK'); } catch {}
        await other.end();
      }
    });

    await t.test('published and superseded catalog snapshots are immutable',async()=>{
      await q('INSERT INTO @price_rules(version_id,code,method,payload) VALUES($1,$2,$3,$4)',[ids.published,'verify_report','per_unit',JSON.stringify({unitMinor:999})]);
      await q("UPDATE @versions SET status='PUBLISHED', approved=true WHERE id=$1",[ids.published]);
      // A second PUBLISHED version in the same scope is refused until the first is superseded.
      await q("INSERT INTO @versions(id,scope_id,status,approved,vat_basis_points) VALUES('00000000-0000-4000-8000-000000000404',$1,'DRAFT',true,2300)",[ids.scope]);
      await assertSqlError(()=>q("UPDATE @versions SET status='PUBLISHED' WHERE id='00000000-0000-4000-8000-000000000404'"),'23505');
      await q("DELETE FROM @versions WHERE id='00000000-0000-4000-8000-000000000404'");
      await assertSqlError(()=>q("UPDATE @price_rules SET payload='{\"unitMinor\":1}'::jsonb WHERE version_id=$1 AND code='verify_report'",[ids.published]),'55000');
      await assertSqlError(()=>q("DELETE FROM @price_rules WHERE version_id=$1 AND code='verify_report'",[ids.published]),'55000');
      await assertSqlError(()=>q('UPDATE @versions SET vat_basis_points=1000 WHERE id=$1',[ids.published]),'55000');
      await q("UPDATE @versions SET status='SUPERSEDED' WHERE id=$1",[ids.published]);
      await assertSqlError(()=>q("UPDATE @versions SET status='PUBLISHED' WHERE id=$1",[ids.published]),'55000');
      await q("UPDATE @price_rules SET payload='{\"unitMinor\":301}'::jsonb WHERE version_id=$1 AND code='verify_report'",[ids.draft]);
      const r=await q("SELECT payload->>'unitMinor' AS amount FROM @price_rules WHERE version_id=$1 AND code='verify_report'",[ids.draft]);
      assert.equal(r.rows[0].amount,'301');
    });

    await t.test('service changes cannot silently violate existing package limits',async()=>{
      await assertSqlError(()=>q("UPDATE @services SET max_quantity=10 WHERE version_id=$1 AND code='report_ext'",[ids.draft]),'22023');
      await assertSqlError(()=>q("UPDATE @services SET quantity_step=2 WHERE version_id=$1 AND code='report_ext'",[ids.draft]),'22023');
      await assertSqlError(()=>q("UPDATE @versions SET status='PUBLISHED' WHERE id=$1",[ids.draft]),'23514');
      await assertSqlError(()=>q("UPDATE @scopes SET scope_code='altered' WHERE id=$1",[ids.scope]),'55000');
    });

    await t.test('unprivileged role cannot read or insert catalog even when granted table rights',async()=>{
      await db.query('CREATE ROLE '+role+' NOLOGIN');
      await db.query('GRANT USAGE ON SCHEMA sc_pricing_isolated TO '+role);
      await db.query('GRANT SELECT,INSERT ON sc_pricing_isolated.versions TO '+role);
      await db.query('SET ROLE '+role);
      try {
        const r=await q('SELECT count(*)::int AS n FROM @versions');
        assert.equal(r.rows[0].n,0);
        await assertSqlError(()=>q("INSERT INTO @versions(id,scope_id,vat_basis_points) VALUES('00000000-0000-4000-8000-000000000405',$1,2300)",[ids.scope]),'42501');
      } finally { await db.query('RESET ROLE'); }
    });
    await t.test('child edit locks parent version and serializes competing publication',async()=>{
      const contender=new pg.Client({connectionString:value});
      await contender.connect();
      try {
        await contender.query('BEGIN');
        await contender.query("UPDATE sc_pricing_isolated.services SET description='in flight' WHERE version_id=$1 AND code='report_ext'",[ids.draft]);
        await db.query("SET lock_timeout='250ms'");
        await assertSqlError(()=>q("UPDATE @versions SET status='PUBLISHED',approved=true WHERE id=$1",[ids.draft]),'55P03');
        await db.query('RESET lock_timeout');
        await contender.query('COMMIT');
        await q("UPDATE @versions SET status='PUBLISHED',approved=true WHERE id=$1",[ids.draft]);
        await assertSqlError(()=>q("UPDATE @services SET description='after publish' WHERE version_id=$1 AND code='report_ext'",[ids.draft]),'55000');
      } finally {
        try { await contender.query('ROLLBACK'); } catch {}
        try { await db.query('RESET lock_timeout'); } catch {}
        await contender.end();
      }
    });

  } finally {
    try { await db.query('RESET ROLE'); } catch {}
    try { await db.query('DROP SCHEMA IF EXISTS sc_pricing_isolated CASCADE'); } catch {}
    try { await db.query('DROP ROLE IF EXISTS '+role); } catch {}
    await db.end();
  }
});
