import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// Offline transport tests; never claim these results prove live Auth/RLS.
for (const scenario of ['viewer','recruiter','regression','duplicate']) {
  test(`membership checker: ${scenario}`,()=>{
    const mock = `
      let role=${JSON.stringify(scenario==='recruiter'?'recruiter':'viewer')};
      const scenario=${JSON.stringify(scenario)};
      globalThis.fetch=async(input,init={})=>{
        const url=new URL(String(input)); const method=init.method||'GET';
        const headers=new Headers(init.headers); const owner=headers.get('authorization')==='Bearer owner-token';
        const body=init.body?JSON.parse(init.body):{};
        const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-supabase-api-version':'2024-01-01'}});
        if(url.pathname==='/auth/v1/token') {
          const id=body.email==='owner@example.invalid'?'owner':'member';
          return json({access_token:id+'-token',refresh_token:'fake-refresh',expires_in:3600,token_type:'bearer',user:{id}});
        }
        if(url.pathname==='/auth/v1/logout') return new Response(null,{status:204});
        if(url.pathname==='/rest/v1/companies') return json({owner_id:'owner',name:'TEST Firma B'});
        if(url.pathname==='/rest/v1/company_members') {
          if(method==='GET') return json({role});
          if(method==='PATCH') {
            if(owner||scenario==='regression') {role=body.role;return json(owner?{role}:[{user_id:'member'}]);}
            return json([]);
          }
          if(method==='POST') return json({code:scenario==='duplicate'?'23505':'42501',message:'synthetic denial'},403);
        }
        throw Error('Unexpected test request');
      };
      process.on('exit',()=>{ if(scenario==='regression' && role!=='viewer') process.exitCode=99; });
    `;
    const run=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(mock),'scripts/check-live-membership.mjs'],{
      encoding:'utf8',env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://wsvjawuikxfzjyivxgsu.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',
        SKILLCHECK_TEST_EMAIL_A:'member@example.invalid',SKILLCHECK_TEST_PASSWORD_A:'fake-only',SKILLCHECK_TEST_EMAIL_B:'owner@example.invalid',SKILLCHECK_TEST_PASSWORD_B:'fake-only'}
    });
    if(['viewer','recruiter'].includes(scenario)) {assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/PASS:/);}
    else {assert.equal(run.status,1,run.stderr);assert.doesNotMatch(run.stdout,/PASS:/);}
    assert.ok(!run.stdout.includes('fake-only') && !run.stderr.includes('fake-only'));
  });
}
