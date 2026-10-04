import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';

// Operator-run audit only. Never use service_role or browser session tokens.
const project = 'https://wsvjawuikxfzjyivxgsu.supabase.co';
const company = 'e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb';
const memberId = '152e0849-9dc0-4845-ba35-90d5acbb3682';
const ownerId = '6b9b367b-effa-43e5-9e4f-b35867eeee3a';
const application = '4a0788c1-8ec9-41a5-942b-82d23e7fd411';
const candidate = '6b30c0a9-edc1-41f7-9576-2a8069dd0142';
const exercise = '73b3666c-317f-4c1d-9b8f-b530a70496ca';
const revision = '2ba871ce-c1ee-467e-8024-7707daa5dd03';
const required = ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SKILLCHECK_TEST_EMAIL_A','SKILLCHECK_TEST_PASSWORD_A','SKILLCHECK_TEST_EMAIL_B','SKILLCHECK_TEST_PASSWORD_B'];
const results = [];
let owner, member, original, restoreNeeded = false;
const client = () => createClient(project, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const record = (label) => { results.push(label); console.log('PASS: '+label); };
function checkLogin(result, expectedId, label) {
  if(result.error) {
    const allowed=['invalid_credentials','over_request_rate_limit','over_email_send_rate_limit','email_not_confirmed','user_banned','unexpected_failure'];
    const code=allowed.includes(result.error.code)?result.error.code:'unclassified_auth_error';
    const status=Number.isInteger(result.error.status)?result.error.status:'unknown';
    assert.fail(label+' AUTH ERROR: '+code+'; HTTP '+status+'. No role changes performed.');
  }
  assert.ok(result.data?.user && result.data?.session,label+' AUTH ERROR: missing user/session.');
  assert.equal(result.data.user.id,expectedId,label+' AUTH OK, ACCOUNT MISMATCH: signed-in account is not the configured audit account.');
}
async function ownerEvidence() {
  const specs = [
    ['stage', 'candidate_assessments','notes,status', 'application_id', application, null, null],
    ['cv', 'candidate_documents','redacted_text,version,status,reviewed_by', 'candidate_id', candidate, null, null],
    ['behavior', 'behavior_assessment_entries','evidence,version,author_id', 'application_id', application, 'area_key','responsibility'],
    ['definition', 'exercise_definition_entries','definition,version,author_id', 'exercise_id', exercise, null,null],
    ['observation', 'exercise_observation_entries','work_sample,version,author_id', 'application_id', application, 'definition_entry_id',revision],
  ];
  const snapshot = {};
  for (const [label,table,columns,filter,value,filter2,value2] of specs) {
    let q = owner.from(table).select(columns).eq('company_id',company).eq(filter,value);
    if (filter2) q=q.eq(filter2,value2);
    const r=await q;
    assert.ok(!r.error && r.data?.length, 'Owner evidence missing: '+label);
    const rows=r.data;
    const latest=label==='stage'?rows[0]:[...rows].sort((a,b)=>b.version-a.version)[0];
    assert.ok(JSON.stringify(latest).includes('TEST RECRUITER C 2026-10-04'),'Expected recruiter evidence missing: '+label);
    assert.ok(!JSON.stringify(rows).includes('TEST VIEWER DENIED'),'Forbidden viewer evidence found: '+label);
    if(label==='cv') { assert.equal(latest.version,4); assert.equal(latest.status,'reviewed'); assert.equal(latest.reviewed_by,memberId); }
    if(['behavior','definition','observation'].includes(label)) { assert.equal(latest.version,2); assert.equal(latest.author_id,memberId); assert.ok(rows.some(r=>r.version===1),'History missing: '+label); }
    snapshot[label]=rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return snapshot;
}
try {
  assert.ok(required.every(k=>process.env[k]),'BLOCKED: private local configuration required.');
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL,project,'Unexpected project.');
  assert.ok(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_'),'Publishable key required.');
  owner=client();
  const login=await owner.auth.signInWithPassword({email:process.env.SKILLCHECK_TEST_EMAIL_B,password:process.env.SKILLCHECK_TEST_PASSWORD_B});
  checkLogin(login,ownerId,'Owner B');
  member=client();
  {
    const r=await member.auth.signInWithPassword({email:process.env.SKILLCHECK_TEST_EMAIL_A,password:process.env.SKILLCHECK_TEST_PASSWORD_A});
    checkLogin(r,memberId,'Member C');
  }
  const c=await owner.from('companies').select('owner_id,name').eq('id',company).single();
  assert.ok(!c.error && c.data?.owner_id===ownerId && c.data.name==='TEST Firma B','Unexpected company.');
  const before=await owner.from('company_members').select('role').eq('company_id',company).eq('user_id',memberId).maybeSingle();
  assert.ok(!before.error,'Cannot read original membership.'); original=before.data?.role??null;
  const evidence=await ownerEvidence(); record('independent owner B: five saved records, expected versions/history, no viewer changes');
  let membershipExists=original!==null;
  for(const role of ['recruiter','viewer']) {
    restoreNeeded=true; // Even an ambiguous failed response must trigger restoration.
    // UPDATE privileges cover role only; upsert would also UPDATE tenant/user keys.
    const grant=membershipExists
      ?await owner.from('company_members').update({role}).eq('company_id',company).eq('user_id',memberId).select('role').single()
      :await owner.from('company_members').insert({company_id:company,user_id:memberId,role}).select('role').single();
    assert.ok(!grant.error && grant.data?.role===role,'Cannot prepare test role.');
    membershipExists=true;
    const own=await member.from('company_members').select('role').eq('company_id',company).eq('user_id',memberId).single();
    assert.ok(!own.error && own.data?.role===role,'Member cannot read prepared role.');
    const changed=await member.from('company_members').update({role:role==='viewer'?'recruiter':'viewer'})
      .eq('company_id',company).eq('user_id',memberId).select('user_id');
    assert.ok(changed.error?.code==='42501' || (!changed.error && Array.isArray(changed.data) && changed.data.length===0),'Member UPDATE not denied: '+role);
    const added=await member.from('company_members').insert({company_id:company,user_id:memberId,role});
    assert.equal(added.error?.code,'42501','Member INSERT not denied by permissions: '+role);
    const unchanged=await owner.from('company_members').select('role').eq('company_id',company).eq('user_id',memberId).single();
    assert.ok(!unchanged.error && unchanged.data?.role===role,'Owner detected changed membership: '+role);
    record('direct API '+role+': membership UPDATE and INSERT denied; owner confirmed role unchanged');
  }
  assert.deepEqual(await ownerEvidence(),evidence,'Owner records changed during role probes.');
  record('owner B independently confirmed records unchanged after API probes');
  if(process.env.SKILLCHECK_OLD_PASSWORD_B) {
    assert.notEqual(process.env.SKILLCHECK_OLD_PASSWORD_B,process.env.SKILLCHECK_TEST_PASSWORD_B,'Old and current password must differ.');
    const old=client();
    try {
      const r=await old.auth.signInWithPassword({email:process.env.SKILLCHECK_TEST_EMAIL_B,password:process.env.SKILLCHECK_OLD_PASSWORD_B});
      assert.ok(r.error?.code==='invalid_credentials' && !r.data.session,'Old password probe did not return invalid_credentials.');
      record('owner-supplied previous password B rejected with invalid_credentials');
    } finally { await old.auth.signOut({scope:'local'}); }
  } else console.log('NOT RUN: previous password B unavailable; no claim of rejection.');
} catch(e) {
  console.error(e instanceof assert.AssertionError?e.message:'BLOCKED: audit request failed; no complete live PASS.'); process.exitCode=1;
} finally {
  if(restoreNeeded && owner) {
    try {
      const restored=original===null
        ?await owner.from('company_members').delete().eq('company_id',company).eq('user_id',memberId)
        :await owner.from('company_members').update({role:original}).eq('company_id',company).eq('user_id',memberId);
      assert.ok(!restored.error);
      const check=await owner.from('company_members').select('role').eq('company_id',company).eq('user_id',memberId).maybeSingle();
      assert.ok(!check.error && (check.data?.role??null)===original);
      record('original membership restored and verified by owner B');
    } catch { console.error('FAIL: inspect C membership in TEST Firma B; automatic cleanup not confirmed.'); process.exitCode=1; }
  }
  await Promise.allSettled([owner,member].filter(Boolean).map(c=>c.auth.signOut({scope:'local'})));
}
if(!process.exitCode) console.log('AUDIT RUN COMPLETE: roles and owner checks passed; onboarding is not tested by this script.');
