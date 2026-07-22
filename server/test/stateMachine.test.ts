import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { createRepos } from '../src/db/repos/index.js';
import { ProjectStateMachine } from '../src/core/stateMachine.js';
import { HttpError } from '../src/core/httpError.js';

function setup() {
  const db = openDb(':memory:');
  const repos = createRepos(db);
  const sm = new ProjectStateMachine(repos.projects);
  repos.projects.insert({ id: 'p1', slug: 'p1', title: 'P1', model: null, workspacePath: '/tmp/x', initialPrompt: 'x' });
  return { repos, sm };
}

describe('ProjectStateMachine', () => {
  it('performs legal transitions', () => {
    const { repos, sm } = setup();
    expect(sm.tryTransition('p1', ['draft'], 'spec_ready')).toBe(true);
    expect(repos.projects.byId('p1')!.status).toBe('spec_ready');
    expect(sm.tryTransition('p1', ['spec_ready'], 'queued')).toBe(true);
    expect(sm.tryTransition('p1', ['queued'], 'building')).toBe(true);
    expect(sm.tryTransition('p1', ['building'], 'paused_limit')).toBe(true);
    expect(sm.tryTransition('p1', ['paused_limit'], 'building')).toBe(true);
    expect(sm.tryTransition('p1', ['building'], 'awaiting_deploy_approval')).toBe(true);
  });

  it('rejects illegal transition declarations', () => {
    const { sm } = setup();
    expect(() => sm.tryTransition('p1', ['draft'], 'building')).toThrow(/transition interdite/);
  });

  it('CAS fails when the current status does not match', () => {
    const { sm } = setup();
    expect(sm.tryTransition('p1', ['spec_ready'], 'queued')).toBe(false);
  });

  it('transitionOr409 throws HttpError on mismatch', () => {
    const { sm } = setup();
    expect(() => sm.transitionOr409('p1', ['spec_ready'], 'queued')).toThrow(HttpError);
  });

  it('terminal statuses accept nothing', () => {
    const { repos, sm } = setup();
    sm.tryTransition('p1', ['draft'], 'canceled');
    expect(repos.projects.byId('p1')!.status).toBe('canceled');
    expect(() => sm.tryTransition('p1', ['canceled'], 'queued')).toThrow(/transition interdite/);
  });
});
