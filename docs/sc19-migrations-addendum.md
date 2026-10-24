# SC-019 migration design addendum — fresh policy remains unconfigured

Date: 2026-10-21. Contract: Issues #93 / #91. Base: `bcc9a200a8a082c13fa3796e9375b37e4b520c8d`.

This addendum supersedes only the fresh-install policy seed in the independently reviewed design `docs/sc19-migrations-design.md` (SHA256 `9f4b1241485bda7f5f195a39e960518f23f1e41989a11bd9fdf51b77a412381c`). It incorporates the parallel architecture review and corrective contract in [Issue #93 comment 6311121961](https://github.com/krzysztofsyska/skillcheck-core/issues/93#issuecomment-6311121961) and [review receipt 6311126867](https://github.com/krzysztofsyska/skillcheck-core/issues/93#issuecomment-6311126867), discovered during the subsequent fresh reconciliation. It does not change the six source schemas or their trusted catalog fingerprints.

## Required behavior

| Source | Policy after successful migration |
| --- | --- |
| `r4_legacy`, `r4_voice` | The existing policy table definition is installed with **zero rows**. No default FREE/PRESELEKCJA quantities or offers are seeded. |
| `r5_legacy`, `r5_voice`, `orders129_legacy`, `orders152_legacy` | Existing reviewed policy rows, including their quantities and timestamps, are adopted without changes. |

Keep the accepted `sc19_claim_trial` and `sc19_grant_paid` function bodies. They already refuse missing policy (`sc19_missing_free_policy` / `sc19_missing_paid_policy`). Test these refusals using an otherwise eligible synthetic company and confirm that no balance, trial claim or journal entry is committed. Package-size RPC returns an empty catalog until explicit later configuration.

Functional credit, payment and retention tests may insert clearly marked synthetic policy rows into their own disposable databases after testing the unconfigured state. Those values are test inputs and are never part of the migration. Existing upgrade fixtures keep their pinned historical source seeds and verify unchanged adoption, including a deliberately changed policy.

No runtime resolver, flag, provider, price, account, production database or activation changes are authorized. Actual policy configuration requires the later owner-approved contract and rollout; this migration does not perform it.

## Verification and review

The final native PostgreSQL 16/17 suites must cover both fresh empty-policy variants, the two missing-policy refusals and no accounting side effects, plus policy preservation on all adopted states. All original migration, SC-010, ACL, locking, payment, purge and restore acceptance criteria remain in force. SQL implementation of this addendum follows independent review; the review receipt and exact final code review belong in the task/PR handoff.
