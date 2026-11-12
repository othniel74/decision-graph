/**
 * Forge function entry points. Keys in manifest.yml map to these exports.
 */
import { runMigrations } from './storage/sql';

export { handler as resolver } from './handlers/resolvers';
export { validateTransition, onIssueEvent } from './handlers/jira-events';
export {
  checkPlanRovo,
  checkPlanMcp,
  listApplicableDecisions,
  explainDecision,
  requestExceptionAction,
  draftDecision,
} from './handlers/rovo';

/** Runs on install/upgrade and on a schedule, so a failed first run self-heals. Idempotent. */
export async function migrate(): Promise<void> {
  try {
    const applied = await runMigrations();
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  } catch (e) {
    console.error('Migration failed', e);
    throw e;
  }
}
