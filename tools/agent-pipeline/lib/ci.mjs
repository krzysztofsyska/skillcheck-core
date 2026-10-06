const FAILURES = new Set(['cancelled', 'skipped', 'neutral', 'timed_out', 'failure', 'stale', 'action_required', 'startup_failure']);

export function validateCi(run, expected) {
  if (!run || typeof run !== 'object') return { ok: false, reason: 'missing_run', pass: false };
  if (run.workflow_id !== expected.workflowId) return { ok: false, reason: 'workflow_mismatch', pass: false };
  if (run.workflow_path !== expected.workflowPath) return { ok: false, reason: 'workflow_mismatch', pass: false };
  if (run.run_attempt !== 1 && expected.requireFirstAttempt !== false) {
    if (run.run_attempt !== expected.runAttempt) return { ok: false, reason: 'attempt_mismatch', pass: false };
  }
  if (run.policy_sha !== expected.policySha) return { ok: false, reason: 'policy_mismatch', pass: false };
  if (run.head_sha !== expected.headSha || run.base_sha !== expected.baseSha) return { ok: false, reason: 'sha_mismatch', pass: false };
  if (run.conclusion !== 'success') {
    return { ok: false, reason: FAILURES.has(run.conclusion) ? `conclusion_${run.conclusion}` : 'conclusion_not_success', pass: false };
  }
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  if (jobs.length === 0) return { ok: false, reason: 'missing_job', pass: false };
  if (jobs.some(job => job.conclusion !== 'success')) return { ok: false, reason: 'job_not_success', pass: false };
  const executed = run.commands_executed ?? [];
  const required = expected.requiredCommands ?? [];
  for (const command of required) {
    if (!executed.includes(command)) return { ok: false, reason: 'required_command_missing', pass: false };
  }
  return { ok: true, pass: true };
}

export function commandsFromPolicy(policy) {
  return (policy.required_ci_commands ?? []).map(command => {
    if (!/^[A-Za-z0-9_.:@/ -]+$/.test(command) || command.includes('&&') || command.includes('|') || command.includes(';')) {
      throw new Error(`Unsafe policy command: ${command}`);
    }
    return { source: 'policy', argv: command.split(' ').filter(Boolean), command };
  });
}
