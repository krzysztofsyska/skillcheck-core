import {
  screeningDispatchBody,
  signScreeningDispatch,
  verifyScreeningDispatch,
} from "../lib/screening-hmac.ts";

if (typeof Buffer !== "undefined") {
  console.error("Buffer is a global in this runtime; the Deno check is inconclusive.");
  Deno.exit(2);
}

const secret = "a".repeat(48);
const body = screeningDispatchBody("11111111-1111-4111-8111-111111111111");
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = signScreeningDispatch(secret, timestamp, body);
const bad = verifyScreeningDispatch({
  secret,
  timestamp,
  signature: "ab".repeat(32),
  body,
});
const good = verifyScreeningDispatch({ secret, timestamp, signature, body });
if (!("ok" in bad) || bad.ok || bad.code !== "signature") {
  console.error(`wrong signature returned ${JSON.stringify(bad)}`);
  Deno.exit(1);
}
if (!good.ok) {
  console.error(`valid signature returned ${JSON.stringify(good)}`);
  Deno.exit(1);
}
console.log("deno-hmac-ok");
