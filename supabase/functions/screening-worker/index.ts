import postgres from "npm:postgres@3.4.7";
import {
  SCREENING_DISPATCH_SIGNATURE_HEADER,
  SCREENING_DISPATCH_TIMESTAMP_HEADER,
  parseScreeningDispatchAttempt,
  verifyScreeningDispatch,
} from "../../../lib/screening-hmac.ts";
import { callOpenAiResponses, runScreeningAttempt } from "../../../lib/screening-worker.ts";
import { screeningClaimRpcName } from "../../../lib/screening-claim-route.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function env(name: string) {
  return Deno.env.get(name) ?? "";
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function workerStore(sql: ReturnType<typeof postgres>) {
  return {
    async claim(attemptId: string) {
      return await sql.begin(async tx => {
        await tx.unsafe("set local role screening_worker");
        const contract = await tx`
          select public.screening_attempt_result_schema_version(${attemptId}::uuid) as version
        `;
        const name = screeningClaimRpcName(Number(contract[0]?.version));
        if (name === "claim_screening_attempt_v2") {
          const rows = await tx`select * from public.claim_screening_attempt_v2(${attemptId}::uuid)`;
          return rows[0] ?? null;
        }
        const rows = await tx`select * from public.claim_screening_attempt(${attemptId}::uuid)`;
        return rows[0] ?? null;
      });
    },
    async complete(input: {
      attemptId: string;
      leaseToken: string;
      inputFingerprint: string;
      analysisContractHash: string;
      findings: unknown;
      providerRequestId: string | null;
      providerResponseId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
    }) {
      const rows = await sql.begin(async tx => {
        await tx.unsafe("set local role screening_worker");
        const useV2 = Array.isArray(input.findings) && input.findings.some(
          (item: any) => item && typeof item === "object" && "verdict" in item
        );
        if (useV2) {
        return await tx`
          select public.complete_screening_evidence(
            ${input.attemptId}::uuid,
            ${input.leaseToken},
            ${input.inputFingerprint},
            ${input.analysisContractHash},
            ${tx.json(input.findings)},
            ${input.providerRequestId},
            ${input.providerResponseId},
            ${input.inputTokens},
            ${input.outputTokens},
            ${input.cachedInputTokens},
            null,
            null
          ) as id
        `;
        }
        return await tx`
          select public.complete_screening_analysis(
            ${input.attemptId}::uuid,
            ${input.leaseToken},
            ${input.inputFingerprint},
            ${input.analysisContractHash},
            ${tx.json(input.findings)},
            ${input.providerRequestId},
            ${input.providerResponseId},
            ${input.inputTokens},
            ${input.outputTokens},
            ${input.cachedInputTokens},
            null,
            null
          ) as id
        `;
      });
      return String(rows[0].id);
    },
    async fail(input: {
      attemptId: string;
      leaseToken: string;
      inputFingerprint: string;
      analysisContractHash: string;
      errorCode: string;
      errorMessage: string;
    }) {
      const rows = await sql.begin(async tx => {
        await tx.unsafe("set local role screening_worker");
        return await tx`
          select public.fail_screening_attempt(
            ${input.attemptId}::uuid,
            ${input.leaseToken},
            ${input.inputFingerprint},
            ${input.analysisContractHash},
            ${input.errorCode},
            ${input.errorMessage},
            null, null, null, null, null, null
          ) as id
        `;
      });
      return rows[0] ? String(rows[0].id) : null;
    },
  };
}

function createRuntime() {
  const sql = postgres(env("SUPABASE_DB_URL"), { prepare: false, max: 1 });
  const apiKey = env("OPENAI_API_KEY");
  return {
    sql,
    runtime: {
      enabled: env("SCREENING_AI_ENABLED") === "true",
      store: workerStore(sql),
      async callOpenAi(request: Parameters<typeof callOpenAiResponses>[1]) {
        return callOpenAiResponses(apiKey, request);
      },
      sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
      log(entry: Record<string, unknown>) {
        console.log(JSON.stringify(entry));
      },
    },
  };
}

const MAX_DISPATCH_BODY_BYTES = 1024;

Deno.serve(async request => {
  if (request.method !== "POST") return json(405, { accepted: false });
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength) || Number(contentLength) > MAX_DISPATCH_BODY_BYTES) {
    return json(413, { accepted: false });
  }
  const body = new Uint8Array(await request.arrayBuffer());
  const verified = verifyScreeningDispatch({
    secret: env("SCREENING_WORKER_DISPATCH_SECRET"),
    timestamp: request.headers.get(SCREENING_DISPATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(SCREENING_DISPATCH_SIGNATURE_HEADER),
    body,
  });
  if (!verified.ok) return json(401, { accepted: false });
  if (env("SCREENING_AI_ENABLED") !== "true") return json(409, { accepted: false });

  let attemptId: string;
  try {
    attemptId = parseScreeningDispatchAttempt(body);
  } catch {
    return json(400, { accepted: false });
  }

  const { sql, runtime } = createRuntime();
  EdgeRuntime.waitUntil((async () => {
    try {
      await runScreeningAttempt(attemptId, runtime);
    } finally {
      await sql.end({ timeout: 5 });
    }
  })());
  return json(202, { accepted: true, attempt_id: attemptId });
});
