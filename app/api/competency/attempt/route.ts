/** Isolated SC-014-B3 broker. No page or candidate invitations (B4 is separate). */
import { competencyBrokerOtherMethod, competencyBrokerPost } from '../../../../lib/competency-attempt-broker-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function POST(request: Request) { return competencyBrokerPost(request); }
export function GET() { return competencyBrokerOtherMethod(); }
export function HEAD() { return competencyBrokerOtherMethod(); }
export function OPTIONS() { return competencyBrokerOtherMethod(); }
export function PUT() { return competencyBrokerOtherMethod(); }
export function PATCH() { return competencyBrokerOtherMethod(); }
export function DELETE() { return competencyBrokerOtherMethod(); }
