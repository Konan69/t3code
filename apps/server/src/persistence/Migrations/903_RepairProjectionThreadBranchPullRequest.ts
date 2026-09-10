/**
 * Repairs databases whose migration ids 48–50 were consumed by this fork's
 * machine-binding and auto-pull repair migrations before upstream claimed them.
 * The migrator skips by id, so those databases never ran upstream's 048 change.
 * Re-applies that idempotent migration above the fork's recorded high-water mark.
 */
export { default } from "./048_ProjectionThreadBranchPullRequest.ts";
