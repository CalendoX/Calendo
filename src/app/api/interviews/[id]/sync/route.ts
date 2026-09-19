import { assertCanManageInterview } from '@/server/authz/policy';
import { apiRoute, authenticate, json } from '@/server/http/handler';
import { requestMeta } from '@/server/http/request';
import { syncInterviewIntegrations } from '@/server/integrations/sync';
import { enqueueInterviewSync } from '@/server/jobs/queue';
import { recordAudit } from '@/server/services/audit';
import { loadInterviewRow } from '../../_shared';

/** Manually retry integration sync (also re-creates meetings/events deleted outside Calendor). */
export const POST = apiRoute<{ id: string }>(async (req, { id }) => {
  const auth = await authenticate(req);
  const interview = await loadInterviewRow(id);
  assertCanManageInterview(auth, interview);
  await recordAudit({
    organizationId: interview.organizationId,
    actor: { type: 'user', userId: auth.user.id },
    action: 'interview.sync_retried',
    resourceType: 'interview',
    resourceId: id,
    meta: requestMeta(req),
  });
  const outcome = await syncInterviewIntegrations(id, { force: true, waitForLeaseMs: 10_000 });
  if (outcome.retryable) await enqueueInterviewSync(id, 'manual_retry');
  return json(outcome);
});
