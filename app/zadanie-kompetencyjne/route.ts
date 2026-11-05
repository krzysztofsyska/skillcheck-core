import { randomBytes } from 'node:crypto';
import { candidateDocument } from '../../lib/competency-candidate-document.ts';

export const dynamic = 'force-dynamic';
export function GET(request:Request) {
  const nonce=randomBytes(18).toString('base64');
  const headers={'content-type':'text/html; charset=utf-8','cache-control':'private, no-store',
    'referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-robots-tag':'noindex, nofollow',
    'content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`};
  const preview = process.env.VERCEL_ENV === 'preview' || process.env.NODE_ENV === 'development';
  if(!preview || process.env.COMPETENCY_CANDIDATE_PREVIEW !== 'true' ||
    process.env.COMPETENCY_BROKER_ENABLED!=='true'||new URL(request.url).search)
    return new Response('Zadanie niedostępne.',{status:404,headers});
  return new Response(candidateDocument(nonce),{headers});
}
