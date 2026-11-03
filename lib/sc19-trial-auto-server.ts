import 'server-only';
/** Server entry point for SC-FREE-AUTO-001. The logic lives in
 * ./sc19-trial-auto-flow.ts, which carries no 'server-only' guard so that tests
 * can exercise it directly; this module is what application code imports, and
 * the guard keeps the flow (and the request secret it reads) out of any client
 * bundle. */
export { activateFreeWithWhitelist, trialStore } from './sc19-trial-auto-flow.ts';
export type {
  RpcError, TrialActivationResult, TrialActivationStatus, TrialDecisionRecord, TrialStore,
} from './sc19-trial-auto-flow.ts';
