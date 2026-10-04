import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';

// Operator-run audit on the dedicated synthetic company only. A means member C.
const companyId = 'e732b9dc-ec23-4bcb-b06f-f7dd9fa2c0fb';
const required = ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SKILLCHECK_TEST_EMAIL_A','SKILLCHECK_TEST_PASSWORD_A','SKILLCHECK_TEST_EMAIL_B','SKILLCHECK_TEST_PASSWORD_B'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('BLOCKED: missing local configuration: '+missing.join(', '));
  process.exitCode=1;
} else {
  const clients = [0,1].map(()=>createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}));
  const [member,owner]=clients;
  let original=null, memberId=null, passed=false, attempted=false;
  try {
    assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL,'https://wsvjawuikxfzjyivxgsu.supabase.co','Unexpected project.');
    const users=[];
    for(const [i,label] of ['A','B'].entries()) {
      const r=await clients[i].auth.signInWithPassword({email:process.env[`SKILLCHECK_TEST_EMAIL_${label}`],password:process.env[`SKILLCHECK_TEST_PASSWORD_${label}`]});
      assert.ok(!r.error && r.data.user,`Login ${label} failed.`); users.push(r.data.user);
    }
    memberId=users[0].id;
    const company=await owner.from('companies').select('owner_id,name').eq('id',companyId).single();
    assert.ok(!company.error && company.data?.name==='TEST Firma B','Expected dedicated TEST Firma B.');
    assert.equal(company.data.owner_id,users[1].id,'Account B must own TEST Firma B.');
    assert.notEqual(memberId,users[1].id,'Member C must not be the owner.');
    const own=await member.from('company_members').select('role').eq('company_id',companyId).eq('user_id',memberId).single();
    assert.ok(!own.error && ['viewer','recruiter'].includes(own.data?.role),'Member C must have the prepared role.');
    original=own.data.role;
    attempted=true;
    const changed=await member.from('company_members').update({role:original==='viewer'?'recruiter':'viewer'})
      .eq('company_id',companyId).eq('user_id',memberId).select('user_id');
    assert.ok(changed.error?.code==='42501' || (!changed.error && Array.isArray(changed.data) && changed.data.length===0),'FAIL: member role update not denied.');
    // Existing primary key avoids adding any person even if the INSERT policy regresses.
    const added=await member.from('company_members').insert({company_id:companyId,user_id:memberId,role:original});
    assert.equal(added.error?.code,'42501','FAIL: membership INSERT was not rejected by permissions (duplicate-key alone is not proof).');
    passed=true;
  } catch(error) {
    console.error(error instanceof assert.AssertionError ? error.message : 'BLOCKED: request failed; no live PASS.');
    process.exitCode=1;
  } finally {
    if(attempted && original && memberId) {
      try {
        const row=await owner.from('company_members').select('role').eq('company_id',companyId).eq('user_id',memberId).single();
        assert.ok(!row.error && row.data,'Could not verify membership after probe.');
        if(row.data.role!==original) {
          const restore=await owner.from('company_members').update({role:original}).eq('company_id',companyId).eq('user_id',memberId).select('role').single();
          assert.ok(!restore.error && restore.data?.role===original,'Could not restore membership.');
          passed=false; process.exitCode=1; console.error('FAIL: original test role restored after unexpected mutation.');
        }
      } catch {
        passed=false; process.exitCode=1; console.error('FAIL: owner must inspect and restore the original C membership role in TEST Firma B.');
      }
    }
    await Promise.allSettled(clients.map(c=>c.auth.signOut({scope:'local'})));
  }
  if(passed && !process.exitCode) console.log(`PASS: ${original} could read own membership but could not update own role or INSERT membership. Owner verified role unchanged.`);
}
