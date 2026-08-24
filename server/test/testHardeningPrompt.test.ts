import { describe, expect, it } from 'vitest';
import type { StackInfo } from '@pjgen/shared';
import { testHardeningPrompt } from '../src/prompts/steps.js';

const stack: StackInfo = {
  language: 'typescript',
  framework: 'react',
  package_manager: 'npm',
  install_cmd: 'npm install',
  build_cmd: 'npm run build',
  test_cmd: 'npm test',
  run_cmd: 'npm run dev',
};

describe('testHardeningPrompt', () => {
  it('instruit des tests E2E front simulant des clics/saisies utilisateur réels', () => {
    const prompt = testHardeningPrompt(stack);
    expect(prompt).toMatch(/end-to-end/i);
    expect(prompt).toMatch(/clics\/saisies utilisateur/i);
    expect(prompt).toMatch(/Playwright/);
  });

  it('couvre le cas d\'erreur (message clair sur saisie invalide)', () => {
    const prompt = testHardeningPrompt(stack);
    expect(prompt).toMatch(/saisie invalide.*message d'erreur clair/i);
  });

  it('couvre le cas nominal (happy path sans erreur console\\/réseau)', () => {
    const prompt = testHardeningPrompt(stack);
    expect(prompt).toMatch(/happy path.*sans erreur console\/réseau/i);
  });

  it("intègre la commande de test du stack fourni", () => {
    const prompt = testHardeningPrompt(stack);
    expect(prompt).toContain('« npm test »');
  });
});
