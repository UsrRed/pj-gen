import { describe, expect, it } from 'vitest';
import type { IssueDecision, IssueDto } from '@pjgen/shared';
import { DEFAULT_ISSUE_LIMIT, sortIssuesByPriority } from '../src/lib/issuePriority.js';

function issue(id: number, decision: IssueDecision, updatedAt: number): IssueDto {
  return {
    id,
    projectId: 'p1',
    number: id,
    title: `issue ${id}`,
    body: '',
    author: 'someone',
    ghState: 'open',
    decision,
    postedCommentAt: null,
    lastSyncedAt: updatedAt,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('sortIssuesByPriority', () => {
  it('ranks in-progress before queued before done, most recent first within each group', () => {
    const issues = [
      issue(1, 'fixed', 500),
      issue(2, 'queued', 100),
      issue(3, 'ci_running', 200),
      issue(4, 'queued', 300),
      issue(5, 'fixing', 400),
      issue(6, 'skipped', 600),
    ];

    const sorted = sortIssuesByPriority(issues);

    expect(sorted.map((i) => i.id)).toEqual([5, 3, 4, 2, 6, 1]);
  });

  it('does not mutate the input array', () => {
    const issues = [issue(1, 'queued', 1), issue(2, 'fixing', 2)];
    const copy = [...issues];
    sortIssuesByPriority(issues);
    expect(issues).toEqual(copy);
  });
});

describe('DEFAULT_ISSUE_LIMIT', () => {
  it('is 3', () => {
    expect(DEFAULT_ISSUE_LIMIT).toBe(3);
  });
});
