import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Offline checker tests only: not evidence of live Auth or RLS.
for (const scenario of ['pass','missing-evidence','escalation','duplicate','cleanup-failure','old-accepted','no-old','auth-invalid','auth-limit','account-mismatch']) {
  test(`final audit checker: ${scenario}`, () => {
    const mock = `
      const scenario=${JSON.stringify(scenario)};
      const owner='6b9b367b-effa-43e5-9e4f-b35867eeee3a', member='152e0849-9dc0-4845-ba35-90d5acbb3682';
      let role=null, granted=false;
      const marker=scenario==='missing-evidence'?'missing':'TEST RECRUITER C 2026-10-04';
      globalThis.fetch=async(input,init={})=>{
        const u=new URL(String(input)), method=init.method||'GET', body=init.body?JSON.parse(init.body):{};
        const isOwner=new Headers(init.headers).get('authorization')==='Bearer '+owner;
        const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-supabase-api-version':'2024-01-01'}});
        if(u.pathname==='/auth/v1/token') {
          if(body.password==='old-private' && scenario!=='old-accepted') return json({code:'invalid_credentials',message:'invalid'},400);
          if(scenario==='auth-invalid') return json({code:'invalid_credentials',message:'current-private'},400);
          if(scenario==='auth-limit') return json({code:'over_request_rate_limit',message:'current-private'},429);
          const id=scenario==='account-mismatch'?'unexpected-user':body.email==='owner@example.invalid'?owner:member;
          return json({access_token:id,refresh_token:'fake-refresh',expires_in:3600,token_type:'bearer',user:{id}});
        }
        if(u.pathname==='/auth/v1/logout') return new Response(null,{status:204});
        if(u.pathname==='/rest/v1/companies') return json({owner_id:owner,name:'TEST Firma B'});
        if(u.pathname==='/rest/v1/company_members') {
          if(method==='GET') return json(role===null?null:{role});
          if(method==='DELETE') { if(scenario==='cleanup-failure') return json({code:'42501'},403); role=null; return new Response(null,{status:204}); }
          if(isOwner) {
            // Match the real column-level grants: only role may be updated.
            if(new Headers(init.headers).get('prefer')?.includes('resolution=merge-duplicates') ||
              (method==='PATCH' && Object.keys(body).some(k=>k!=='role'))) return json({code:'42501'},403);
            if(method==='POST' && role!==null) return json({code:'23505'},409);
            if(method==='PATCH' && role===null) return json(null);
            role=body.role; granted=true; return json({role});
          }
          if(method==='PATCH') { if(scenario==='escalation') {role=body.role;return json([{user_id:member}]);} return json([]); }
          return json({code:scenario==='duplicate'?'23505':'42501'},403);
        }
        const t=u.pathname.split('/').at(-1);
        if(t==='candidate_assessments') return json([{notes:marker,status:'in_progress'}]);
        if(t==='candidate_documents') return json([{redacted_text:marker,version:4,status:'reviewed',reviewed_by:member}]);
        const field={behavior_assessment_entries:'evidence',exercise_definition_entries:'definition',exercise_observation_entries:'work_sample'}[t];
        if(field) return json([{[field]:'original',version:1,author_id:owner},{[field]:marker,version:2,author_id:member}]);
        throw Error('Unexpected offline request');
      };
      process.on('exit',()=>{if(granted && scenario!=='cleanup-failure' && role!==null) process.exitCode=99;});
    `;
    const env={...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://wsvjawuikxfzjyivxgsu.supabase.co',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',
      SKILLCHECK_TEST_EMAIL_A:'member@example.invalid',SKILLCHECK_TEST_PASSWORD_A:'current-private',
      SKILLCHECK_TEST_EMAIL_B:'owner@example.invalid',SKILLCHECK_TEST_PASSWORD_B:'current-private',SKILLCHECK_OLD_PASSWORD_B:scenario==='no-old'?'':'old-private'};
    const r=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(mock),'scripts/check-live-final-audit.mjs'],{env,encoding:'utf8',timeout:20000});
    assert.equal(r.status,['pass','no-old'].includes(scenario)?0:1,r.stderr);
    if(scenario==='pass') { assert.match(r.stdout,/previous password B rejected/); assert.match(r.stdout,/AUDIT RUN COMPLETE/); }
    if(scenario==='no-old') assert.match(r.stdout,/NOT RUN: previous password/);
    if(scenario==='auth-invalid') assert.match(r.stderr,/AUTH ERROR: invalid_credentials; HTTP 400/);
    if(scenario==='auth-limit') assert.match(r.stderr,/AUTH ERROR: over_request_rate_limit; HTTP 429/);
    if(scenario==='account-mismatch') assert.match(r.stderr,/AUTH OK, ACCOUNT MISMATCH/);
    if(scenario==='cleanup-failure') assert.match(r.stderr,/automatic cleanup not confirmed/);
    if(!['pass','no-old'].includes(scenario)) assert.doesNotMatch(r.stdout,/AUDIT RUN COMPLETE/);
    assert.doesNotMatch(r.stdout+r.stderr,/current-private|old-private/);
  });
}
