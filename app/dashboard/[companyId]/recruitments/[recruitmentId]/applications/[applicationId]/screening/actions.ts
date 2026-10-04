"use server";

import { dispatchScreeningWorker } from "../../../../../../../../lib/screening-dispatch";

export async function dispatchPreparedScreening(attemptId: string) {
  return dispatchScreeningWorker(attemptId);
}
