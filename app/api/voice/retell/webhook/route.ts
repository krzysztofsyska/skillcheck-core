import { createRetellWebhookHttp, resolveRetellWebhookRuntime } from '../../../../../lib/voice/retell-webhook-http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request: Request) {
  return createRetellWebhookHttp(await resolveRetellWebhookRuntime())(request);
}
