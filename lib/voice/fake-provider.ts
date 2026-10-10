/** SC-011-A synthetic in-memory adapter. No network, numbers, prompts, or audio stored. */
import { createHash } from "node:crypto";
import {
  canonicalVoiceCallRequest, VoiceProviderUncertainError, VoiceProviderValidationError,
  type VoiceCallAcceptance, type VoiceCallLookup, type VoiceCallRequest, type VoiceProvider,
} from "./provider.ts";

export type FakeVoiceMode = "accepted" | "timeout_before_acceptance" | "timeout_after_acceptance";
type Entry = { fingerprint: string; providerCallId: string; status: "accepted" | "cancelled" };

export class FakeVoiceProvider implements VoiceProvider {
  private readonly byKey = new Map<string, Entry>();
  private readonly byId = new Map<string, Entry>();
  private sequence = 0;
  private readonly mode: FakeVoiceMode;
  private readonly supportsLookup: boolean;
  constructor(mode: FakeVoiceMode = "accepted", supportsLookup = true) {
    this.mode = mode;
    this.supportsLookup = supportsLookup;
  }

  async initiateOutbound(request: VoiceCallRequest): Promise<VoiceCallAcceptance> {
    const canonical = canonicalVoiceCallRequest(request);
    const fingerprint = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
    const previous = this.byKey.get(canonical.providerIdempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.status !== "accepted")
        throw new VoiceProviderValidationError();
      return { acceptance: "accepted", providerCallId: previous.providerCallId };
    }
    if (this.mode === "timeout_before_acceptance") throw new VoiceProviderUncertainError();
    const providerCallId = "fake-call-" + String(++this.sequence).padStart(6, "0");
    const record: Entry = { fingerprint, providerCallId, status: "accepted" };
    this.byKey.set(canonical.providerIdempotencyKey, record);
    this.byId.set(providerCallId, record);
    if (this.mode === "timeout_after_acceptance") throw new VoiceProviderUncertainError();
    return { acceptance: "accepted", providerCallId };
  }

  async getCallByIdempotencyKey(key: string): Promise<VoiceCallLookup> {
    if (!this.supportsLookup) return { state: "unsupported" };
    const record = this.byKey.get(key);
    return record
      ? { state: "found", providerCallId: record.providerCallId, status: record.status }
      : { state: "not_found" };
  }

  async cancelCall(providerCallId: string): Promise<void> {
    const record = this.byId.get(providerCallId);
    if (!record) throw new VoiceProviderValidationError();
    record.status = "cancelled";
  }

  get syntheticCallCount(): number { return this.sequence; }
}
