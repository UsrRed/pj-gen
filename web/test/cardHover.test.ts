import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cssPath = resolve(dirname(__filename), '../src/index.css');
const css = readFileSync(cssPath, 'utf-8');

function ruleFor(className: string): string {
  const marker = `.${className} {`;
  const start = css.indexOf(marker);
  expect(start, `expected ${marker} to exist in index.css`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

describe('card hover/focus transitions', () => {
  it('card-hover has a smooth transition with elevation feedback, matching the ~150-200ms button animation', () => {
    const rule = ruleFor('card-hover');
    expect(rule).toMatch(/duration-(150|200|250)/);
    expect(rule).toMatch(/ease-out|ease-in-out|ease/);
    expect(rule).toMatch(/transition-(all|colors|transform|shadow)/);
    expect(rule).toMatch(/hover:-translate-y/);
    expect(rule).toMatch(/hover:shadow/);
    expect(rule).toMatch(/focus-visible:ring/);
  });

  it('base card has a smooth transition so state changes stay fluid', () => {
    const rule = ruleFor('card');
    expect(rule).toMatch(/transition-/);
  });
});

describe('decorative page background', () => {
  it('body has a subtle gradient background without a strong opaque overlay', () => {
    const bodyStart = css.indexOf('body {');
    const bodyEnd = css.indexOf('}', bodyStart);
    const bodyRule = css.slice(bodyStart, bodyEnd);
    expect(bodyRule).toMatch(/radial-gradient|linear-gradient/);
    // low opacity so the gradient stays discreet and doesn't hurt text legibility
    const alphaMatches = [...bodyRule.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(alphaMatches.length).toBeGreaterThan(0);
    for (const alpha of alphaMatches) {
      expect(alpha).toBeLessThanOrEqual(0.2);
    }
  });
});
