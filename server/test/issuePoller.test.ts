import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import type { CiState, GithubService } from '../src/github/githubService.js';
import type { MicroService } from '../src/micro/microService.js';
import { AI_MARKER, IssuePoller, buildIssueRequest, isPjGenComment, type IssueComment } from '../src/github/issuePoller.js';
import { testContainer } from './helpers.js';

const ISSUE = { number: 7, author: 'alice', title: 'Bouton export cassé', body: 'Le bouton ne fait rien.' };

describe('isPjGenComment', () => {
  const at = '2026-07-22T10:00:00Z';

  it('true for our login + AI marker', () => {
    expect(isPjGenComment({ author: { login: 'UsrRed' }, createdAt: at, body: `Quel navigateur ?\n\n_Message ${AI_MARKER}` }, 'UsrRed')).toBe(true);
  });

  it('false for a manual comment from our login (no marker)', () => {
    expect(isPjGenComment({ author: { login: 'UsrRed' }, createdAt: at, body: 'Firefox 128.' }, 'UsrRed')).toBe(false);
  });

  it('false for another author even if the marker is quoted', () => {
    expect(isPjGenComment({ author: { login: 'alice' }, createdAt: at, body: `_Message ${AI_MARKER}` }, 'UsrRed')).toBe(false);
  });

  it('false when ourLogin is unknown', () => {
    expect(isPjGenComment({ author: { login: 'UsrRed' }, createdAt: at, body: `_Message ${AI_MARKER}` }, null)).toBe(false);
  });
});

describe('buildIssueRequest', () => {
  it('without comments nor assets: same shape as before (title + body)', () => {
    expect(buildIssueRequest(ISSUE, [], [], 'UsrRed')).toBe('Issue GitHub #7 de @alice — Bouton export cassé\n\nLe bouton ne fait rien.');
  });

  it('includes the comment thread and labels our clarification question by its AI marker', () => {
    const comments: IssueComment[] = [
      { author: { login: 'UsrRed' }, createdAt: '2026-07-22T10:00:00Z', body: `Quel navigateur ?\n\n_Message ${AI_MARKER}` },
      { author: { login: 'alice' }, createdAt: '2026-07-22T11:00:00Z', body: 'Firefox 128, voir la capture.' },
    ];
    const req = buildIssueRequest(ISSUE, comments, [], 'UsrRed');
    expect(req).toContain('Fil de commentaires');
    expect(req).toContain('pj-gen (notre commentaire) — 2026-07-22T10:00:00Z :\nQuel navigateur ?');
    expect(req).toContain('@alice — 2026-07-22T11:00:00Z :\nFirefox 128, voir la capture.');
  });

  it("labels the owner's manual comments with their login, not as pj-gen", () => {
    const comments: IssueComment[] = [
      { author: { login: 'UsrRed' }, createdAt: '2026-07-22T10:00:00Z', body: 'Précision : uniquement sur mobile.' },
    ];
    const req = buildIssueRequest(ISSUE, comments, [], 'UsrRed');
    expect(req).toContain('@UsrRed — 2026-07-22T10:00:00Z :\nPrécision : uniquement sur mobile.');
    expect(req).not.toContain('pj-gen (notre commentaire)');
  });

  it('caps the thread to the 10 last comments and 2000 chars each', () => {
    const comments: IssueComment[] = Array.from({ length: 12 }, (_, i) => ({
      author: { login: 'alice' },
      createdAt: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      body: `commentaire ${i + 1} ` + 'x'.repeat(3000),
    }));
    const req = buildIssueRequest(ISSUE, comments, [], null);
    expect(req).not.toContain('commentaire 2 ');
    expect(req).toContain('commentaire 3 ');
    expect(req).toContain('commentaire 12 ');
    expect(req).not.toContain('x'.repeat(2001));
  });

  it('lists downloaded assets with their local path, failed ones with the error', () => {
    const req = buildIssueRequest(
      ISSUE,
      [],
      [
        { url: 'https://github.com/user-attachments/assets/ok1', file: '/data/issue-assets/p/7/piece-jointe-1.png', ok: true },
        { url: 'https://github.com/user-attachments/assets/ko2', file: null, ok: false, error: 'HTTP 404' },
      ],
      null
    );
    expect(req).toContain('- /data/issue-assets/p/7/piece-jointe-1.png (téléchargée depuis https://github.com/user-attachments/assets/ok1)');
    expect(req).toContain('- https://github.com/user-attachments/assets/ko2 (téléchargement échoué : HTTP 404)');
  });
});

/** Stub GithubService: everything the poller touches, network-free. */
class FakeGithub {
  ci: CiState = 'pending';
  ciCalls = 0;
  pushed = 0;
  closed: number[] = [];
  comments: { number: number; body: string }[] = [];
  issues: { number: number; title: string; body: string; author: { login: string }; updatedAt: string }[] = [];

  async status() {
    return { installed: true, authOk: true, login: 'UsrRed', detail: '' };
  }
  async listIssues() {
    return this.issues;
  }
  async issueComments() {
    return [];
  }
  async downloadIssueAttachments() {
    return [];
  }
  async syncState() {
    return { ahead: 0, behind: 0 };
  }
  async push() {
    this.pushed++;
  }
  async ciStatus() {
    this.ciCalls++;
    return this.ci;
  }
  async issueComment(_repo: string, number: number, body: string) {
    this.comments.push({ number, body });
  }
  async issueClose(_repo: string, number: number) {
    this.closed.push(number);
  }
}

/** Stub MicroService: records the order issues are handed to it, always fails fast. */
class FakeMicro {
  calls: number[] = [];
  quotaBlocked() {
    return false;
  }
  async create(_projectId: string, _request: string, _source: 'manual' | 'issue', issueId: number | null) {
    this.calls.push(issueId!);
    return { status: 'failed' as const, message: 'stub' };
  }
}

describe('IssuePoller drainQueued: processes the lowest issue number first', () => {
  let cRef: Container | null = null;
  let pollerRef: IssuePoller | null = null;
  afterEach(() => {
    pollerRef?.stop();
    pollerRef = null;
    cRef?.close();
    cRef = null;
  });

  it('among several queued issues, the lowest number is drained before the higher ones', async () => {
    const { c } = await testContainer();
    cRef = c;
    const slug = 'drain-order';
    const workspacePath = await c.ws.create(slug, 'Drain Order');
    const id = 'drain-order-id';
    c.repos.projects.insert({ id, slug, title: 'Drain Order', model: null, workspacePath, initialPrompt: 'test' });
    c.repos.projects.casStatus(id, ['draft'], 'deployed');
    c.repos.projects.patch(id, { github_repo: 'usrred/drain-order', github_private: 1, github_auto_mode: 1 });

    const numbers = [9, 2, 5];
    const idByNumber = new Map<number, number>();
    for (const number of numbers) {
      const { row } = c.repos.issues.upsert(id, {
        number,
        title: `Issue ${number}`,
        body: 'corps',
        author: 'alice',
        ghUpdatedAt: '2026-07-22T00:00:00Z',
      });
      c.repos.issues.patch(row.id, { decision: 'queued' });
      idByNumber.set(number, row.id);
    }

    const gh = new FakeGithub();
    // Keep the issues open across ticks (sync would otherwise close anything absent from `remote`).
    gh.issues = numbers.map((number) => ({
      number,
      title: `Issue ${number}`,
      body: 'corps',
      author: { login: 'alice' },
      updatedAt: '2026-07-22T00:00:00Z',
    }));
    const micro = new FakeMicro();
    const poller = new IssuePoller(c, gh as unknown as GithubService, micro as unknown as MicroService);
    pollerRef = poller;

    await poller.tick(); // one in-flight fix per project: drains #2, then fails fast
    await poller.tick(); // frees the gate: drains #5
    await poller.tick(); // frees the gate: drains #9

    expect(micro.calls).toEqual([idByNumber.get(2), idByNumber.get(5), idByNumber.get(9)]);
  });
});

describe('IssuePoller CI gate (finalizeFixing)', () => {
  let cRef: Container | null = null;
  let pollerRef: IssuePoller | null = null;
  afterEach(() => {
    pollerRef?.stop();
    pollerRef = null;
    cRef?.close();
    cRef = null;
  });

  async function setup(opts: { withCi: boolean }) {
    const { c } = await testContainer();
    cRef = c;
    const slug = 'ci-gate';
    const workspacePath = await c.ws.create(slug, 'CI Gate');
    const id = 'ci-gate-id';
    c.repos.projects.insert({ id, slug, title: 'CI Gate', model: null, workspacePath, initialPrompt: 'test' });
    c.repos.projects.casStatus(id, ['draft'], 'deployed');
    c.repos.projects.patch(id, {
      github_repo: 'usrred/ci-gate',
      github_private: 1,
      github_auto_mode: 1,
      github_last_push_sha: 'abc1234def',
    });
    if (opts.withCi) c.ws.writeFile(workspacePath, '.github/workflows/ci.yml', 'name: ci\n');

    const gh = new FakeGithub();
    gh.issues = [{ number: 5, title: 'Bug bouton', body: 'corps', author: { login: 'alice' }, updatedAt: '2026-07-22T00:00:00Z' }];
    const { row } = c.repos.issues.upsert(id, { number: 5, title: 'Bug bouton', body: 'corps', author: 'alice', ghUpdatedAt: '2026-07-22T00:00:00Z' });
    c.repos.issues.patch(row.id, { decision: 'fixing' });
    const mr = c.repos.micro.insert(id, 'issue', 'Corrige le bouton.', row.id);
    c.repos.micro.patch(mr.id, { status: 'done' });

    const poller = new IssuePoller(c, gh as unknown as GithubService, c.micro);
    pollerRef = poller;
    const issue = () => c.repos.issues.byNumber(id, 5)!;
    return { c, gh, poller, issue };
  }

  it('waits for CI: fixing → ci_running, no close while runs are pending, close + fixed on green', async () => {
    const { gh, poller, issue } = await setup({ withCi: true });

    await poller.tick(); // push sync ok → enters the CI gate
    expect(issue().decision).toBe('ci_running');
    expect(gh.closed).toEqual([]);
    expect(gh.comments).toEqual([]);

    await poller.tick(); // CI still pending → nothing settles
    expect(issue().decision).toBe('ci_running');
    expect(gh.closed).toEqual([]);

    gh.ci = 'success';
    await poller.tick();
    expect(issue().decision).toBe('fixed');
    expect(gh.closed).toEqual([5]);
    expect(gh.comments[0].body).toContain('Correctif appliqué');
    expect(gh.comments[0].body).toContain(AI_MARKER);
  });

  it('red CI: comments and marks failed, the issue stays OPEN on GitHub', async () => {
    const { gh, poller, issue } = await setup({ withCi: true });

    await poller.tick();
    gh.ci = 'failure';
    await poller.tick();
    expect(issue().decision).toBe('failed');
    expect(gh.closed).toEqual([]); // never closed
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0].body).toContain('La CI a échoué');
    expect(gh.comments[0].body).toContain(AI_MARKER);
  });

  it('repo without workflow files: closes immediately, CI never queried', async () => {
    const { gh, poller, issue } = await setup({ withCi: false });

    await poller.tick();
    expect(issue().decision).toBe('fixed');
    expect(gh.closed).toEqual([5]);
    expect(gh.ciCalls).toBe(0);
  });

  it('inconclusive CI past the grace period: closes with a caveat instead of blocking forever', async () => {
    const { c, gh, poller, issue } = await setup({ withCi: true });
    gh.ci = 'none';

    await poller.tick();
    expect(issue().decision).toBe('ci_running');
    // Backdate the wait start beyond the 30 min grace period.
    c.repos.issues.patch(issue().id, { posted_comment_at: Date.now() - 31 * 60_000 });
    await poller.tick();
    expect(issue().decision).toBe('fixed');
    expect(gh.closed).toEqual([5]);
    expect(gh.comments[0].body).toContain('Statut CI non confirmé');
  });
});
