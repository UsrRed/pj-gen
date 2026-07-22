import { describe, expect, it } from 'vitest';
import { ciStateOf } from '../src/github/githubService.js';

const done = (conclusion: string) => ({ status: 'completed', conclusion });

describe('ciStateOf', () => {
  it('none without any run (repo without CI or run not registered yet)', () => {
    expect(ciStateOf([])).toBe('none');
  });

  it('pending while at least one run is not completed', () => {
    expect(ciStateOf([done('success'), { status: 'in_progress', conclusion: '' }])).toBe('pending');
    expect(ciStateOf([{ status: 'queued', conclusion: '' }])).toBe('pending');
  });

  it('success when every run concluded green (skipped/neutral count as green)', () => {
    expect(ciStateOf([done('success')])).toBe('success');
    expect(ciStateOf([done('success'), done('skipped'), done('neutral')])).toBe('success');
  });

  it('failure as soon as one run concluded red', () => {
    expect(ciStateOf([done('success'), done('failure')])).toBe('failure');
    expect(ciStateOf([done('cancelled')])).toBe('failure');
    expect(ciStateOf([done('timed_out')])).toBe('failure');
  });
});
