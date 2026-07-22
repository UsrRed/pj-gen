import type { ProjectStatus } from '@pjgen/shared';
import { STATUS_COLORS, STATUS_LABELS } from '../i18n/fr.js';

export function StatusBadge({ status, pulse }: { status: ProjectStatus; pulse?: boolean }) {
  const active = status === 'building' || status === 'deploying';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}>
      {(pulse ?? active) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATUS_LABELS[status]}
    </span>
  );
}
