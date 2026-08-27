import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { IssueDecision, IssueDto } from '@pjgen/shared';
import { IssuesSection } from '../src/pages/GithubPage.js';

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

const issues = [
  issue(1, 'fixed', 500),
  issue(2, 'queued', 100),
  issue(3, 'ci_running', 200),
  issue(4, 'queued', 300),
  issue(5, 'fixing', 400),
  issue(6, 'skipped', 600),
];

function renderSection() {
  return render(
    <MemoryRouter>
      <IssuesSection issues={issues} onDecision={vi.fn()} busy={null} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('IssuesSection', () => {
  it('shows only 3 issues by default, in-progress first then queued then done', () => {
    renderSection();
    expect(screen.getByText('issue 5')).toBeInTheDocument();
    expect(screen.getByText('issue 3')).toBeInTheDocument();
    expect(screen.getByText('issue 4')).toBeInTheDocument();
    expect(screen.queryByText('issue 2')).not.toBeInTheDocument();
    expect(screen.queryByText('issue 1')).not.toBeInTheDocument();
    expect(screen.queryByText('issue 6')).not.toBeInTheDocument();
  });

  it('reveals the remaining issues after clicking the expand control', () => {
    renderSection();
    fireEvent.click(screen.getByText(/Voir 3 de plus/));
    expect(screen.getByText('issue 2')).toBeInTheDocument();
    expect(screen.getByText('issue 1')).toBeInTheDocument();
    expect(screen.getByText('issue 6')).toBeInTheDocument();
    expect(screen.getByText('Réduire')).toBeInTheDocument();
  });
});
