import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

const styles = {
  info: { box: 'bg-sky-50 border-sky-200 text-sky-900', icon: Info, iconCls: 'text-sky-600' },
  success: { box: 'bg-emerald-50 border-emerald-200 text-emerald-900', icon: CheckCircle2, iconCls: 'text-emerald-600' },
  warning: { box: 'bg-amber-50 border-amber-200 text-amber-900', icon: AlertTriangle, iconCls: 'text-amber-600' },
  error: { box: 'bg-rose-50 border-rose-200 text-rose-900', icon: XCircle, iconCls: 'text-rose-600' },
};

export function Alert({ tone = 'info', title, children, action, className }: { tone?: keyof typeof styles; title?: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  const s = styles[tone];
  const Icon = s.icon;
  return (
    <div className={cn('flex gap-3 rounded-xl border px-4 py-3 text-sm', s.box, className)} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', s.iconCls)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn('leading-relaxed', title && 'mt-0.5 opacity-90')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
