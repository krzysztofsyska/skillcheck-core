import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

test('real Next actions send PKCE email redirects to a local protocol stub (no email delivery)', async t => {
  const requests = [];
  let recoveryError = null;
  const auth = createServer(async (req,res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://localhost');
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ url, body });
    res.setHeader('Content-Type','application/json');
    res.setHeader('X-Supabase-Api-Version','2024-01-01');
    if (url.pathname === '/auth/v1/signup') res.end(JSON.stringify({id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',email:'test@example.invalid',created_at:new Date().toISOString()}));
    else if (url.pathname === '/auth/v1/recover') {
      if (recoveryError) { res.statusCode = recoveryError.status; res.end(JSON.stringify({code:recoveryError.code,msg:'Synthetic provider failure'})); }
      else res.end('{}');
    }
    else if (url.pathname === '/auth/v1/token' && body.auth_code === 'good-code' && body.code_verifier) {
      const exp = Math.floor(Date.now()/1000)+3600;
      const jwt = ['{"alg":"none"}',JSON.stringify({sub:'00000000-0000-0000-0000-000000000001',exp,aud:'authenticated'}),''].map((p,i)=>i<2?Buffer.from(p).toString('base64url'):'synthetic').join('.');
      res.end(JSON.stringify({access_token:jwt,token_type:'bearer',expires_in:3600,expires_at:exp,refresh_token:'synthetic',user:{id:'00000000-0000-0000-0000-000000000001',aud:'authenticated',email:'test@example.invalid'}}));
    }
    else { res.statusCode=400; res.end(JSON.stringify({error:'invalid_grant',error_description:'Test expired code'})); }
  });
  await new Promise(resolve => auth.listen(0,'127.0.0.1',resolve));
  t.after(() => { auth.closeAllConnections(); auth.close(); });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{
    env:{...process.env,VERCEL_ENV:'',NEXT_PUBLIC_SITE_URL:base,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${auth.address().port}`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'test-only-key'},stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>child.kill());
  let logs=''; child.stdout.on('data',chunk=>{logs+=chunk;}); child.stderr.on('data',chunk=>{logs+=chunk;});
  let ready=false;
  for(let i=0;i<60;i++) {
    if(child.exitCode!==null) throw new Error(logs);
    try {ready=(await fetch(base)).ok;} catch {}
    if(ready) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Next server ready');
  {
    // Registration without accepting Regulamin + DPA + privacy notice never reaches Supabase.
    const html=await (await fetch(base+'/register')).text();
    assert.match(html,/name="legal_acceptance"/);
    for (const href of ['/regulamin','/regulamin/umowa-powierzenia','/polityka-prywatnosci']) assert.ok(html.includes(`href="${href}"`),href);
    const action=html.match(/name="(\$ACTION_ID_[^"]+)"/);
    for (const value of [null,'on','v0.9']) {
      const form=new FormData(); form.set(action[1],''); form.set('email','test@example.invalid'); form.set('password','test-password-long');
      if (value) form.set('legal_acceptance',value);
      const response=await fetch(base+'/register',{method:'POST',body:form,headers:{Origin:base},redirect:'manual'});
      assert.equal(response.status,303);
      assert.equal(new URL(response.headers.get('location'),base).search,'?message=terms');
    }
    assert.equal(requests.some(r=>r.url.pathname==='/auth/v1/signup'),false,'no signup without legal acceptance');
  }
  for (const [page,endpoint,callback,destination] of [
    ['/register','/auth/v1/signup','/auth/callback','/login?message=confirm'],
    ['/forgot-password','/auth/v1/recover','/auth/callback?flow=recovery','/forgot-password?message=sent'],
  ]) {
    const html=await (await fetch(base+page)).text();
    const action=html.match(/name="(\$ACTION_ID_[^"]+)"/);
    assert.ok(action,'Server action is exposed in the real form');
    const form=new FormData(); form.set(action[1],''); form.set('email','test@example.invalid'); form.set('password','test-password-long');
    if (page==='/register') form.set('legal_acceptance','v1.0+aneks1');
    const response=await fetch(base+page,{method:'POST',body:form,headers:{Origin:base},redirect:'manual'});
    assert.equal(response.status,303);
    assert.equal(new URL(response.headers.get('location'),base).pathname+new URL(response.headers.get('location'),base).search,destination);
    const sent=requests.find(r=>r.url.pathname===endpoint);
    assert.ok(sent,'Local stub received the auth request');
    assert.equal(sent.url.searchParams.get('redirect_to'),base+callback);
    assert.equal(sent.body.code_challenge_method,'s256');
    assert.ok(sent.body.code_challenge.length>20);
    if (page==='/register') {
      assert.equal(sent.body.data?.legal_acceptance?.version,'1.0');
      assert.equal(sent.body.data.legal_acceptance.revision,'1.0+aneks1');
      assert.deepEqual(sent.body.data.legal_acceptance.documents,['regulamin','dpa','polityka-prywatnosci','aneks-1-rozmowy-glosowe']);
      assert.ok(!Number.isNaN(Date.parse(sent.body.data.legal_acceptance.accepted_at)));
    }
    const cookies=response.headers.getSetCookie();
    assert.ok(cookies.some(cookie=>cookie.includes('code-verifier')),'PKCE verifier is saved for the callback');
  }
  for (const [code,status,message] of [['over_email_send_rate_limit',429,'rate-limit'],['unexpected_failure',500,'unavailable']]) {
    recoveryError = {code,status};
    const html = await (await fetch(base+'/forgot-password')).text();
    const action = html.match(/name="(\$ACTION_ID_[^"]+)"/);
    assert.ok(action);
    const form = new FormData(); form.set(action[1],''); form.set('email','test@example.invalid');
    const response = await fetch(base+'/forgot-password',{method:'POST',body:form,headers:{Origin:base},redirect:'manual'});
    assert.equal(response.status,303);
    assert.equal(new URL(response.headers.get('location'),base).search,'?message='+message);
    const feedback = await (await fetch(base+'/forgot-password?message='+message)).text();
    if (message === 'rate-limit') assert.match(feedback,/Osiągnięto limit wysyłki wiadomości aplikacji/);
    else assert.match(feedback,/Nie udało się wysłać instrukcji/);
  }
  // Supabase Site URL fallback: the home page forwards the code, and the stored PKCE verifier still says
  // whether it was a password recovery or a sign-up confirmation.
  const home=await fetch(base+'/');
  assert.equal(home.status,200);
  const failed=await fetch(base+'/?error=access_denied&error_code=otp_expired',{redirect:'manual'});
  assert.equal(failed.status,307);
  assert.equal(new URL(failed.headers.get('location'),base).pathname+new URL(failed.headers.get('location'),base).search,'/login?message=callback');
  assert.match(failed.headers.get('cache-control'),/no-store/);
  recoveryError = null;
  for (const [page,sent,destination] of [['/forgot-password','/forgot-password?message=sent','/reset-password'],['/register','/login?message=confirm','/dashboard']]) {
    const html=await (await fetch(base+page)).text();
    const action=html.match(/name="(\$ACTION_ID_[^"]+)"/);
    const form=new FormData(); form.set(action[1],''); form.set('email','test@example.invalid'); form.set('password','test-password-long');
    if (page==='/register') form.set('legal_acceptance','v1.0+aneks1');
    const started=await fetch(base+page,{method:'POST',body:form,headers:{Origin:base},redirect:'manual'});
    assert.equal(new URL(started.headers.get('location'),base).pathname+new URL(started.headers.get('location'),base).search,sent,page);
    const cookie=started.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    const forwarded=await fetch(base+'/?code=good-code',{headers:{Cookie:cookie},redirect:'manual'});
    assert.equal(forwarded.status,307);
    assert.equal(new URL(forwarded.headers.get('location'),base).pathname+new URL(forwarded.headers.get('location'),base).search,'/auth/callback?code=good-code');
    assert.equal(forwarded.headers.get('referrer-policy'),'no-referrer');
    const finished=await fetch(new URL(forwarded.headers.get('location'),base),{headers:{Cookie:cookie},redirect:'manual'});
    assert.equal(finished.status,307);
    assert.equal(new URL(finished.headers.get('location'),base).pathname,destination,page);
  }
  const rejected=await fetch(base+'/auth/callback?code=expired&flow=recovery',{redirect:'manual'});
  assert.equal(rejected.status,307);
  assert.equal(new URL(rejected.headers.get('location'),base).search,'?message=callback');
  assert.match(rejected.headers.get('cache-control'),/no-store/);
  assert.equal(rejected.headers.get('referrer-policy'),'no-referrer');
});
