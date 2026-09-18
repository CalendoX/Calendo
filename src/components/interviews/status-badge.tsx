import { Badge, type BadgeTone } from '@/components/ui/badge';
import { INTERVIEW_STATUS_LABELS, SYNC_STATUS_LABELS } from '@/lib/format';

type InterviewStatus = keyof typeof INTERVIEW_STATUS_LABELS;
type SyncStatus = keyof typeof SYNC_STATUS_LABELS;

const STATUS_TONES: Record<InterviewStatus, BadgeTone> = {
  scheduled: 'brand',
  rescheduled: 'violet',
  cancelled: 'red',
  completed: 'neutral',
  no_show: 'orange',
};

export function InterviewStatusBadge({ status }: { status: InterviewStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot>
      {INTERVIEW_STATUS_LABELS[status]}
    </Badge>
  );
}

const SYNC_TONES: Record<SyncStatus, BadgeTone> = {
  pending: 'blue',
  synced: 'green',
  failed: 'red',
  cancelled: 'neutral',
  deleted_externally: 'amber',
};

export function SyncBadge({ status, label }: { status: SyncStatus | null; label?: string }) {
  if (!status) return <span className="text-xs text-zinc-400">—</span>;
  return (
    <Badge tone={SYNC_TONES[status]}>
      {label ? `${label}: ` : ''}
      {SYNC_STATUS_LABELS[status]}
    </Badge>
  );
}
