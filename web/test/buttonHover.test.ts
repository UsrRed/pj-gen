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

describe('button hover transitions', () => {
  for (const className of ['btn-primary', 'btn-ghost', 'btn-danger']) {
    it(`${className} has a smooth transition with elevation and scale feedback`, () => {
      const rule = ruleFor(className);
      // duration within the ~150-250ms range requested by the task
      expect(rule).toMatch(/duration-(150|200|250)/);
      expect(rule).toMatch(/ease-out|ease-in-out|ease/);
      expect(rule).toMatch(/transition-(all|colors|transform)/);
      // hover: elevation + shadow change
      expect(rule).toMatch(/hover:-translate-y/);
      expect(rule).toMatch(/hover:shadow/);
      // active: subtle scale feedback
      expect(rule).toMatch(/active:scale-/);
      // focus-visible ring
      expect(rule).toMatch(/focus-visible:ring/);
    });
  }
});
