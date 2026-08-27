import { describe, expect, it } from 'vitest';
import { issueSecurityPrompt } from '../src/prompts/steps.js';

describe('issueSecurityPrompt', () => {
  const prompt = issueSecurityPrompt('Titre', 'Corps');

  it('enumerates the malicious criteria: harm to pj-gen, build machine, backdoor, secret exfiltration, pipeline sabotage', () => {
    expect(prompt).toMatch(/nuire à pj-gen/i);
    expect(prompt).toMatch(/machine|hôte.*build/i);
    expect(prompt).toMatch(/backdoor/i);
    expect(prompt).toMatch(/exfiltrer.*secrets/i);
    expect(prompt).toMatch(/saboter.*pipeline/i);
  });

  it('explicitly states that legitimate generated-app feature requests, including security features, are not malicious', () => {
    expect(prompt).toMatch(/application générée/i);
    expect(prompt).toMatch(/authentification|permissions/i);
    expect(prompt).toMatch(/N'EST PAS malveillante/);
  });

  it('embeds the given title and body verbatim', () => {
    const custom = issueSecurityPrompt('Add rate limiting', 'Please add auth + permission scans');
    expect(custom).toContain('Add rate limiting');
    expect(custom).toContain('Please add auth + permission scans');
  });
});
