// R3 SC-016a — end-to-end acceptance test of the Assessment Center (ROADMAP R3, "Gotowe"):
//  1. the rule who may be an assessor (the owner or a current recruiter of the company that owns
//     the recruitment, never a viewer, a stranger or a person of another company);
//  2. a full session with two assessors on two fictitious finalists, from the exercise sheets to
//     the session report;
//  3. an account without the ASSESSMENT CENTER package has no session, an account with a paid
//     package has one (the package granted the one way the app grants it, sc19_stripe.grant_package).
// Detailed behaviour (races, erasure, rollback, every refusal) stays in ac-session-database,
// ac-session-concurrency, ac-package-gate-database and ac-assessor-names-database; this file only
// walks the whole path once. Native disposable PostgreSQL, full migration chain, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sessionBoot, users, hrbpCaseTemplate, sheetFor, work } from './helpers/ac-session-fixture.mjs';
import { parseAssessmentCenterSession, buildAssessmentCenterSessionReport, AC_NO_DATA } from '../lib/assessment-center-session.ts';

const code = (...codes) => error => codes.includes(error.code);
const forbidden = code('42501', 'PT404');
const packageRequired = error => error.code === 'PT402' && error.message === 'Assessment Center package required';
const assessorUnavailable = error => error.code === '42501' && /Assessor unavailable/.test(error.message);
const justification = 'Po rozmowie asesorzy przyjęli tę ocenę na podstawie obu obserwacji.';

test('R3 SC-016a: package gate, assessor rule and a full two-assessor session on fictitious finalists', async t => {
  const e = await sessionBoot(t, { throughMigration: null });
  const { db, h, call } = e;
  const first = users.owner, second = users.recruiter, viewer = users.viewer;

  // Company A buys the package, company B never does. Each has shortlisted finalists.
  const a1 = await e.finalist(), a2 = await e.finalist();
  const b1 = await e.finalist(users.otherOwner);
  await h.asUser(first);
  await h.insert('company_members', { company_id: a1.companyId, user_id: viewer, role: 'viewer' });
  const scalar = async (sql, args = []) => { await h.asAdmin(); return (await db.query(sql, args)).rows[0].v; };
  const buyPackage = async f => {
    await h.asAdmin();
    const id = randomUUID(), sid = `cs_test_${id.replace(/-/g, '')}`, key = `pi_synthetic_${id.replace(/-/g, '')}`;
    await db.query(`insert into sc19_stripe.package_orders(id,company_id,buyer_id,request_id,package_code,offer_id,offer_revision,terms_revision,
      amount_minor,currency,credits,provider,account,mode,status,session_id,checkout_url,checkout_deadline_ms)
      values($1,$2,$3,$4,'ASSESSMENT_CENTER','synthetic-offer','r1','t1',149900,'PLN',50,'stripe','ktig-consulting','test','awaiting_payment',$5,$6,1)`,
    [id, f.companyId, f.owner, randomUUID(), sid, `https://checkout.stripe.com/c/pay/${sid}`]);
    assert.equal(await scalar('select sc19_stripe.grant_package($1,$2) v', [id, key]), null);
    await db.query("update sc19_stripe.package_orders set status='paid', payment_id=$2 where id=$1", [id, key]);
  };
  const create = async (f, user = f.owner) => {
    await h.asUser(user);
    return call('public.ac_session_create', [f.recruitment.id, hrbpCaseTemplate.title, hrbpCaseTemplate.plannedCompetencies]);
  };

  await t.test('no package: the owner of company A and company B get no session, and learn nothing about each other', async () => {
    await assert.rejects(create(a1), packageRequired);
    await assert.rejects(create(b1), packageRequired);
    await assert.rejects(create(a1, users.otherOwner), forbidden);
    assert.equal(await scalar('select count(*)::int v from private.ac_sessions'), 0);
    await h.asUser(first);
    assert.equal(await e.find(a1), null);
  });

  await buyPackage(a1);

  await t.test('paid package: only company A can plan; company B still has no access and no foreign visibility', async () => {
    await assert.rejects(create(b1), packageRequired);
    await assert.rejects(create(a1, viewer), forbidden);
    await assert.rejects(create(a1, second), forbidden);
    assert.equal(await scalar("select available::int v from sc19_commerce.entitlements where company_id=$1 and code='package:ASSESSMENT_CENTER'", [a1.companyId]), 1);
    assert.equal(await scalar("select count(*)::int v from sc19_commerce.entitlements where company_id=$1 and code='package:ASSESSMENT_CENTER'", [b1.companyId]), 0);
  });

  await h.asUser(first);
  const { sessionId, stages } = await e.plan(a1, { acPackage: false });
  await e.addFinalist(sessionId, a1);
  await e.addFinalist(sessionId, a2);
  assert.deepEqual((await e.read(sessionId)).session.uncoveredCompetencies, []);
  await e.setStatus(sessionId, 'open');

  await t.test('assessor rule: owner and a current recruiter only; a viewer, a stranger and another company are refused', async () => {
    await h.asUser(first);
    for (const refused of [viewer, users.outsider, users.otherOwner]) {
      await assert.rejects(e.assign(sessionId, stages[0], a1, first, refused), assessorUnavailable, 'as second');
      await assert.rejects(e.assign(sessionId, stages[0], a1, refused, second), assessorUnavailable, 'as first');
    }
    await assert.rejects(e.assign(sessionId, stages[0], a1, first, first), code('42501'), 'one person cannot be both assessors');
    assert.equal(await scalar('select count(*)::int v from private.ac_paired_sheets where application_id=$1', [a1.application.id]), 0);
    // Company B cannot see or touch company A's session.
    await h.asUser(users.otherOwner);
    assert.equal(await e.find(a1), null);
    await assert.rejects(e.read(sessionId), code('42501'));
    await assert.rejects(e.setStatus(sessionId, 'closed'), forbidden);
  });

  const pairs = new Map();
  await t.test('both assessors work every stage of both finalists independently, reconcile and confirm', async () => {
    for (const finalist of [a1, a2]) {
      for (const stage of stages) {
        await h.asUser(first);
        const pairId = await e.assign(sessionId, stage, finalist, first, second);
        pairs.set(`${finalist.application.id}:${stage.id}`, pairId);
        await e.submit(pairId, sheetFor(stage.definition));
        // The first assessor cannot see the second sheet, nor reconcile, before the second one is in.
        assert.deepEqual(await call('public.ac_read_pair', [pairId]), { state: 'pending', ownSubmitted: true });
        await assert.rejects(e.reconcile(pairId, []), code('22023', 'PT409'));
        await h.asUser(second);
        await e.submit(pairId, sheetFor(stage.definition));
        const items = stage.definition.criteria.map((_, criterionIndex) => ({ criterionIndex, outcome: 'agreed', rating: 'meets', justification }));
        await e.reconcile(pairId, items);
        await assert.rejects(e.confirm(pairId), code('42501'), 'the author of the record cannot confirm it');
        await h.asUser(first);
        await e.confirm(pairId);
      }
    }
    assert.equal(await scalar('select count(*)::int v from private.ac_reconciliations where confirmation=$1', ['confirmed']), stages.length * 2);
  });

  await t.test('second attempt of finalist 1: first work, feedback, revised work and proof of change', async () => {
    const stage = stages[0];
    await h.asUser(first);
    await e.record(sessionId, a1, stage, 'first_attempt', { work: work('pierwsza próba') });
    await h.asUser(second);
    await e.record(sessionId, a1, stage, 'feedback', { feedback: 'Oddziel przyczyny od objawów i oprzyj wniosek na danych.' });
    await h.asUser(first);
    await e.record(sessionId, a1, stage, 'revised_attempt', { work: work('poprawiona praca') });
    await e.record(sessionId, a1, stage, 'change_proof', { changes: 'Kandydat oddzielił przyczyny od objawów.', evidence: 'Nowa tabela przyczyn z danymi.', assessment: 'change_confirmed' });
    await e.record(sessionId, a1, null, 'expert_consultation', { note: 'Konsultacja eksperta: omówiono wnioski obu asesorów.' });
  });

  await t.test('report: both assessors on every competency of both finalists, agreed ratings, gaps stay explicit, no ranking or decision', async () => {
    await h.asUser(first);
    const raw = await e.read(sessionId);
    const report = buildAssessmentCenterSessionReport(parseAssessmentCenterSession(raw));
    assert.deepEqual(report.uncovered, []);
    assert.equal(report.finalists.length, 2);
    for (const finalist of report.finalists) {
      assert.ok(finalist.competencies.length > 0);
      for (const competency of finalist.competencies) {
        assert.equal(competency.hasEvidence, true, competency.competency);
        for (const row of competency.evidence) {
          assert.deepEqual(row.assessors.map(s => s.authorId), [first, second], competency.competency);
          assert.ok(row.assessors.every(s => s.rating === 'meets' && s.evidence && s.context));
          assert.equal(row.agreement.status, 'agreed');
          assert.equal(row.agreement.rating, 'meets');
        }
      }
    }
    const [one, two] = report.finalists;
    assert.equal(one.attempts[0].firstAttempt.work, work('pierwsza próba'));
    assert.equal(one.attempts[0].revisedAttempt.work, work('poprawiona praca'));
    assert.equal(one.attempts[0].changeProof.assessment, 'change_confirmed');
    assert.equal(one.expertNotes.length, 1);
    // The second finalist did no second attempt: an explicit gap, never a default value.
    assert.ok(two.attempts.every(x => x.firstAttempt === null && x.revisedAttempt === null && x.changeProof === null));
    assert.equal(AC_NO_DATA, 'brak danych');
    assert.doesNotMatch(JSON.stringify([raw, report]), /"(score|rank|ranking|position|recommendation|hiringDecision|decision|total|average)"/i);
    // A viewer of the company and another company's owner get nothing.
    for (const user of [viewer, users.otherOwner]) {
      await h.asUser(user);
      await assert.rejects(e.read(sessionId), code('42501'));
    }
  });

  await t.test('closing needs no package; the closed report is frozen and the package is not consumed', async () => {
    await h.asAdmin();
    await db.query("update sc19_commerce.entitlements set available=0 where company_id=$1 and code='package:ASSESSMENT_CENTER'", [a1.companyId]);
    await h.asUser(first);
    const before = JSON.stringify((await e.read(sessionId)).finalists);
    await e.setStatus(sessionId, 'closed');
    const closed = await e.read(sessionId);
    assert.equal(closed.session.status, 'closed');
    assert.equal(JSON.stringify(closed.finalists), before);
    await assert.rejects(e.setStatus(sessionId, 'open'), code('PT409'));
    assert.equal(await scalar("select used::int v from sc19_commerce.entitlements where company_id=$1 and code='package:ASSESSMENT_CENTER'", [a1.companyId]), 0);
  });
});
