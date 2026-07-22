import { describe, expect, it } from 'vitest';
import { buildIssueRequest, type IssueComment } from '../src/github/issuePoller.js';

const ISSUE = { number: 7, author: 'alice', title: 'Bouton export cassé', body: 'Le bouton ne fait rien.' };

describe('buildIssueRequest', () => {
  it('without comments nor assets: same shape as before (title + body)', () => {
    expect(buildIssueRequest(ISSUE, [], [], 'UsrRed')).toBe('Issue GitHub #7 de @alice — Bouton export cassé\n\nLe bouton ne fait rien.');
  });

  it('includes the comment thread and labels our clarification question', () => {
    const comments: IssueComment[] = [
      { author: { login: 'UsrRed' }, createdAt: '2026-07-22T10:00:00Z', body: 'Quel navigateur ?' },
      { author: { login: 'alice' }, createdAt: '2026-07-22T11:00:00Z', body: 'Firefox 128, voir la capture.' },
    ];
    const req = buildIssueRequest(ISSUE, comments, [], 'UsrRed');
    expect(req).toContain('Fil de commentaires');
    expect(req).toContain('pj-gen (notre commentaire) — 2026-07-22T10:00:00Z :\nQuel navigateur ?');
    expect(req).toContain('@alice — 2026-07-22T11:00:00Z :\nFirefox 128, voir la capture.');
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
