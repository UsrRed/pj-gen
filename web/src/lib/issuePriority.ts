import type { IssueDecision, IssueDto } from '@pjgen/shared';

export const DEFAULT_ISSUE_LIMIT = 3;

const GROUP_BY_DECISION: Record<IssueDecision, 0 | 1 | 2> = {
  fixing: 0,
  ci_running: 0,
  escalated: 0,
  needs_clarification: 0,
  queued: 1,
  pending: 1,
  fixed: 2,
  failed: 2,
  skipped: 2,
  blocked_security: 2,
};

export function sortIssuesByPriority(issues: IssueDto[]): IssueDto[] {
  return [...issues].sort((a, b) => {
    const groupDiff = GROUP_BY_DECISION[a.decision] - GROUP_BY_DECISION[b.decision];
    if (groupDiff !== 0) return groupDiff;
    return b.updatedAt - a.updatedAt;
  });
}
