# Read-only ruleset visibility experiment

TASK: SC-OPS-RULESET-VISIBILITY | LEVEL: L3 | SCOPE: OPERATIONS
OWNER: Codex / Builder | REVIEWER: separate session | DEPENDS ON: #379

The probe asks GitHub GraphQL for bypass actors on two existing controls:
writer `26864086` (expected to contain exactly one App `5216184` with `ALWAYS` bypass) and quality rule
`25299230` (expected empty). It uses one fixed read-only query and bounded
pagination. It never modifies GitHub, creates credentials or changes controller
configuration. The PR job has only `contents: read`, no environment and no
secrets other than its automatic `GITHUB_TOKEN`.

`capability: true` means both controls were fully observed as expected with the
supplied token. `false` records an access denial or null bypass connection;
`null` means unknown (including changed controls, missing/partial data, errors
and pagination limits). A completed probe job is not a protection check PASS.
Every result explicitly denies protection and controller activation authority.

This experiment does **not** prove access for `skillcheck-agent-ks` with
Administration:read, nor does it audit all effective rules. A later authorized
run may call the same script with an already-issued scoped App token as
`GITHUB_TOKEN` and `PROBE_TOKEN_SOURCE=existing-app-token`; this patch does not
issue, store or disclose that token. The source label is declared context, not
verified identity. No result is consumed by the controller preflight.

Acceptance: offline parser/transport tests pass and the ordinary PR workflow
publishes a capability observation. A denied observation is a useful result;
do not widen permissions to make it green.

Primary schema references:
- https://docs.github.com/en/graphql/reference/repos#repositoryruleset
- https://docs.github.com/en/graphql/reference/apps#app
- https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset

REST explicitly restricts disclosure of `bypass_actors` to callers with write
access to the ruleset. GraphQL's schema describes the nullable field but does
not promise that this token can read it. This experiment measures that gap.
