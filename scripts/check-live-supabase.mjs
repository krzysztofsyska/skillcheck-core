import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { checkTenantReads } from './live-tenant-check.mjs';

// Read-only live check. Use two confirmed test accounts belonging to distinct firms.
// Credentials stay in .env.local / process environment and are never printed.
const required = ['NEXT_PUBLIC_SUPABASE_URL','SKILLCHECK_TEST_EMAIL_A','SKILLCHECK_TEST_PASSWORD_A','SKILLCHECK_TEST_EMAIL_B','SKILLCHECK_TEST_PASSWORD_B'];
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const missing = required.filter(name => !process.env[name]);
if (!key) missing.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
if (missing.length) {
  console.error('Brak konfiguracji testu rzeczywistego Supabase: ' + missing.join(', '));
  process.exitCode = 1;
} else {
  const clients = ['A','B'].map(() => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}));
  try {
    const firms = [];
    for (const [index,label] of ['A','B'].entries()) {
      const client = clients[index];
      const login = await client.auth.signInWithPassword({email:process.env[`SKILLCHECK_TEST_EMAIL_${label}`],password:process.env[`SKILLCHECK_TEST_PASSWORD_${label}`]});
      assert.ok(!login.error && login.data.session,`Nie udało się zalogować konta testowego ${label}.`);
      const user = await client.auth.getUser();
      assert.ok(!user.error && user.data.user,`Brak potwierdzonej sesji ${label}.`);
      const company = await client.from('companies').select('id');
      assert.ok(!company.error && company.data.length,`Konto ${label} wymaga istniejącej firmy testowej.`);
      firms.push(company.data.map(row=>row.id));
    }
    await checkTenantReads(clients, firms);
    console.log('PASS: dwa rzeczywiste logowania, odczyt własnych rekordów i blokada odczytu obcej firmy w 10 tabelach. Bez zmian danych.');
  } catch (error) {
    console.error(error instanceof assert.AssertionError ? error.message : 'Błąd połączenia z Supabase; test nie został ukończony.');
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(clients.map(client=>client.auth.signOut({scope:'local'})));
  }
}
