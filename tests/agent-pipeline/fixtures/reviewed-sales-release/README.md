# Historical sales release fixture

These five `.blob` files contain the exact Git blob bytes pinned by
`REVIEWED_SALES_BLOBS` in `tools/agent-pipeline/lib/sales-release-verified.mjs`.
Each filename is the original blob object ID. They were extracted with
`git cat-file blob <object-id>` and are test data, not application source.

The positive verifier test creates a temporary Git history from these immutable
reviewed bytes and verifies that its resulting blob IDs match the trusted
manifest. Keeping the bytes in the test fixture allows shallow CI checkouts and
later application changes without relabeling those changes as reviewed.

Do not refresh these fixtures from the current application or update the trusted
manifest to make an unrelated change pass. The negative regression confirms that
subsequent marketing edits still fail the historical release check. Passing the
verifier never grants Production authorization.
