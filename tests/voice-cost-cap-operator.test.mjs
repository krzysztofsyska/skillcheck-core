// R7: the voice cost cap owner alert, visible to the platform operator in
// /operator/ai-costs (no external send). Offline: no database, no network,
// synthetic data only. The database side (operator-only functions) is covered by
// tests/voice-cost-cap-database.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as cap from '../lib/voice/cost-cap-operator.ts';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function load(file, mocks = {}) {
  const path = new URL('../' + file, import.meta.url).pathname;
  const mod = new Module(path); mod.filename = path;
  mod.paths = Module._nodeModulePaths(new URL('../', import.meta.url).pathname);
  const req = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : req(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } }).outputText, path);
  return mod.exports;
}
const css = new Proxy({}, { get: (_, key) => String(key) });
const { VoiceCostCapSection } = load('app/operator/ai-costs/voice-cost-cap.tsx', {
  '../../../lib/voice/cost-cap-operator': cap, '../sales/sales.module.css': { default: css }, './ai-costs.module.css': { default: css },
});
const render = view => renderToStaticMarkup(React.createElement(VoiceCostCapSection, { view }));

const statusRow = (over = {}) => ({
  month: '2026-11-01', cap_grosze: 5000, call_reserve_grosze: 1500, recorded_cost_grosze: 1234, in_flight_grosze: 1500,
  month_to_date_grosze: 2734, remaining_grosze: 2266, new_calls_blocked: false, reserve_exceeded: false, alert_recorded_at: null, ...over,
});
const alertRows = [
  { month: '2026-11-01', cause: 'dispatch', cap_grosze: 5000, month_to_date_grosze: 4500, recorded_at: '2026-11-20T09:15:00Z' },
  { month: '2026-10-01', cause: 'reserve_exceeded', cap_grosze: 5000, month_to_date_grosze: 1905, recorded_at: '2026-10-03T22:30:00Z' },
];

test('amounts are integer grosze formatted in Polish złoty; months and times in Polish (Europe/Warsaw)', () => {
  assert.equal(cap.formatGrosze(5000), '50,00 zł');
  assert.equal(cap.formatGrosze(0), '0,00 zł');
  assert.equal(cap.formatGrosze(1505), '15,05 zł');
  assert.equal(cap.formatGrosze(7), '0,07 zł');
  assert.equal(cap.formatVoiceMonth('2026-11-01'), 'listopad 2026');
  // 22:30 UTC on 3 Oct is 00:30 on 4 Oct in Warsaw.
  assert.match(cap.formatVoiceTime('2026-10-03T22:30:00Z'), /4 paź 2026.*00:30/);
});

test('parsers accept the database rows (bigint as string too) and reject anything malformed', () => {
  const s = cap.parseVoiceCapStatus([statusRow({ month_to_date_grosze: '2734', alert_recorded_at: '2026-11-20T09:15:00Z' })]);
  assert.deepEqual(s, { month: '2026-11-01', capGrosze: 5000, callReserveGrosze: 1500, recordedCostGrosze: 1234, inFlightGrosze: 1500,
    monthToDateGrosze: 2734, remainingGrosze: 2266, newCallsBlocked: false, reserveExceeded: false, alertRecordedAt: '2026-11-20T09:15:00Z' });
  for (const bad of [null, [], [statusRow(), statusRow()], [statusRow({ cap_grosze: -1 })], [statusRow({ remaining_grosze: 1.5 })],
    [statusRow({ month: '2026-11-15' })], [statusRow({ new_calls_blocked: 'true' })], [statusRow({ alert_recorded_at: 'yesterday' })],
    [statusRow({ in_flight_grosze: undefined })]]) assert.equal(cap.parseVoiceCapStatus(bad), null, JSON.stringify(bad));
  assert.deepEqual(cap.parseVoiceOwnerAlerts(alertRows).map(a => a.cause), ['dispatch', 'reserve_exceeded']);
  assert.deepEqual(cap.parseVoiceOwnerAlerts([]), []);
  for (const bad of [null, {}, [{ ...alertRows[0], cause: 'other' }], [{ ...alertRows[0], cause: '__proto__' }],
    [{ ...alertRows[0], recorded_at: null }], [{ ...alertRows[0], month_to_date_grosze: -5 }]])
    assert.equal(cap.parseVoiceOwnerAlerts(bad), null, JSON.stringify(bad));
  assert.equal(cap.voiceCallsLeft(cap.parseVoiceCapStatus([statusRow()])), 1);
  assert.equal(cap.voiceCallsLeft(cap.parseVoiceCapStatus([statusRow({ new_calls_blocked: true })])), 0);
});

test('loader: the two operator functions, bounded alert list; 42501 is forbidden, any other failure unavailable', async () => {
  const calls = [];
  const client = (status, alerts) => ({ async rpc(name, args) {
    calls.push({ name, args });
    return name === 'r7_operator_voice_cost_cap' ? status : alerts;
  } });
  const ok = await cap.loadVoiceCostCap(client({ data: [statusRow()], error: null }, { data: alertRows, error: null }));
  assert.equal(ok.state, 'ready');
  assert.equal(ok.alerts.length, 2);
  assert.deepEqual(calls, [{ name: 'r7_operator_voice_cost_cap', args: undefined },
    { name: 'r7_operator_voice_owner_alerts', args: { result_limit: 12 } }]);
  assert.equal(await cap.loadVoiceCostCap(client({ data: null, error: { code: '42501' } }, { data: [], error: null })), 'forbidden');
  assert.equal(await cap.loadVoiceCostCap(client({ data: [statusRow()], error: null }, { data: null, error: { code: '42501' } })), 'forbidden');
  for (const [status, alerts] of [
    [{ data: null, error: { code: 'PGRST202', message: 'PRIVATE sql detail' } }, { data: [], error: null }],
    [{ data: [statusRow()], error: null }, { data: null, error: { code: 'XX000' } }],
    [{ data: [statusRow({ cap_grosze: 'x' })], error: null }, { data: [], error: null }],
    [{ data: [statusRow()], error: null }, { data: [{ cause: 'dispatch' }], error: null }],
  ]) assert.deepEqual(await cap.loadVoiceCostCap(client(status, alerts)), { state: 'unavailable' });
});

test('section renders the month, cap, month-to-date cost, open calls and recorded alerts', () => {
  const html = render({ state: 'ready', status: cap.parseVoiceCapStatus([statusRow({ alert_recorded_at: '2026-11-20T09:15:00Z' })]),
    alerts: cap.parseVoiceOwnerAlerts(alertRows) });
  assert.match(html, /<h2 id="voice-cap">Limit kosztu rozmów voicebota<\/h2>/);
  assert.match(html, /Miesiąc: <strong>listopad 2026<\/strong>/);
  assert.match(html, /Limit miesięczny: <strong>50,00 zł<\/strong>/);
  assert.match(html, /Koszt od początku miesiąca: <strong>27,34 zł<\/strong>/);
  assert.match(html, /rozliczone 12,34 zł, rezerwy rozmów bez rozliczenia 15,00 zł/);
  assert.match(html, /Zostało: <strong>22,66 zł<\/strong>/);
  assert.match(html, /można zlecać \(zmieszczą się jeszcze 1\)/);
  assert.doesNotMatch(html, /wstrzymane do 1\. dnia/);
  assert.match(html, /Alert dla właściciela w tym miesiącu: <strong>zapisany 20 lis 2026.*10:15<\/strong>/);
  assert.match(html, /nic nie jest wysyłane e-mailem ani SMS-em/);
  assert.match(html, /firmy go nie widzą/);
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'header plus two alerts');
  assert.match(html, /<th scope="row">październik 2026<\/th><td>Rozmowa kosztowała więcej niż kwota zarezerwowana/);
  assert.match(html, /<td>45,00 zł<\/td><td>50,00 zł<\/td>/);
  assert.match(html, /<td>19,05 zł<\/td>/);
});

test('section: blocked month, empty alert list and unavailable read', () => {
  const blocked = render({ state: 'ready', status: cap.parseVoiceCapStatus([statusRow({ remaining_grosze: 0, month_to_date_grosze: 5000,
    new_calls_blocked: true, reserve_exceeded: true })]), alerts: [] });
  assert.match(blocked, /data-status="unavailable">wstrzymane do 1\. dnia następnego miesiąca/);
  assert.match(blocked, /Rozmowa kosztowała więcej niż zarezerwowana kwota/);
  assert.match(blocked, /Alert dla właściciela w tym miesiącu: brak/);
  assert.match(blocked, /Limit nie został jeszcze wyczerpany — brak alertów\./);
  assert.doesNotMatch(blocked, /<table/);
  const unavailable = render({ state: 'unavailable' });
  assert.match(unavailable, /Nie udało się odczytać limitu rozmów voicebota/);
  assert.doesNotMatch(unavailable, /zł/);
});

test('operator only: the page checks the operator before reading, 42501 becomes 404, nothing else imports the view', () => {
  const page = read('app/operator/ai-costs/page.tsx');
  const gate = page.indexOf('await salesOperator()');
  const voiceRead = page.indexOf('loadVoiceCostCap(client)');
  assert.ok(gate > 0 && voiceRead > gate, 'operator gate runs before the voice cap read');
  assert.match(page, /if \(voiceCap === 'forbidden'\) notFound\(\);/);
  assert.match(page, /<VoiceCostCapSection view=\{voiceCap\} \/>/);
  assert.match(read('app/operator/sales/access.ts'), /rpc\('platform_operator_status'\)[\s\S]*if \(data !== true\) notFound\(\);/);
  // Customers never see voicebot info: only the operator panel uses the view.
  const users = [];
  const walk = dir => { for (const name of readdirSync(new URL(`../${dir}`, import.meta.url))) {
    const path = `${dir}/${name}`;
    if (statSync(new URL(`../${path}`, import.meta.url)).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name) && /cost-cap-operator|voice-cost-cap'|r7_operator_voice/.test(read(path))) users.push(path);
  } };
  walk('app'); walk('lib');
  assert.deepEqual(users.sort(), ['app/operator/ai-costs/page.tsx', 'app/operator/ai-costs/voice-cost-cap.tsx',
    'lib/supabase/database.types.ts', 'lib/voice/cost-cap-operator.ts']);
  // No outbound channel in the alert path.
  for (const file of ['lib/voice/cost-cap-operator.ts', 'app/operator/ai-costs/voice-cost-cap.tsx'])
    assert.doesNotMatch(read(file), /fetch\(|resend|sendMail|nodemailer|twilio|webhook/i, file);
});

test('migration: operator-gated read-only functions for authenticated only, rollback pair, preview list', () => {
  const sql = read('supabase/migrations/20261121140000_r7_voice_cost_cap_operator_view.sql');
  assert.equal((sql.match(/perform private\.sc19_require_operator\(\);/g) || []).length, 2);
  assert.equal((sql.match(/security definer set search_path=''/g) || []).length, 2);
  assert.match(sql, /grant execute on function public\.r7_operator_voice_cost_cap\(\),public\.r7_operator_voice_owner_alerts\(integer\) to authenticated;/);
  assert.equal((sql.match(/^\s*grant /gim) || []).length, 1, 'one grant, to authenticated');
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate)\b\s+(into\s+)?voice_budget/i);
  assert.doesNotMatch(sql, /on schema voice_budget|service_role;/);
  const down = read('supabase/rollbacks/20261121140000_r7_voice_cost_cap_operator_view_down.sql');
  assert.match(down, /drop function if exists public\.r7_operator_voice_owner_alerts\(integer\);/);
  assert.match(down, /drop function if exists public\.r7_operator_voice_cost_cap\(\);/);
  assert.doesNotMatch(down, /voice_budget\./);
  const list = read('supabase/preview-migrations.txt').split('\n');
  assert.ok(list.indexOf('20261121140000_r7_voice_cost_cap_operator_view.sql') > list.indexOf('20261121120000_r7_voice_cost_cap.sql'));
});
