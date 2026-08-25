import { describe, expect, it } from 'vitest';
import { featureAuditPrompt } from '../src/prompts/steps.js';
import { FeatureAuditZ, FEATURE_AUDIT_JSON_SCHEMA } from '../src/prompts/schemas.js';

describe('QA visuelle headless (T14, remplace l\'extension Chrome — issue #8)', () => {
  it('featureAuditPrompt renvoie à docs/qa/screenshots/ comme preuve visuelle', () => {
    const prompt = featureAuditPrompt(false);
    expect(prompt).toMatch(/docs\/qa\/screenshots\//);
    expect(prompt).toMatch(/screenshots/);
  });

  it('FeatureAuditZ accepte un champ screenshots optionnel par fonctionnalité', () => {
    const withShots = FeatureAuditZ.safeParse({
      features: [{ key: 'F1', title: 'Export', status: 'ok', evidence: 'ok', fix_hint: '', screenshots: ['docs/qa/screenshots/happy-path.png'] }],
    });
    expect(withShots.success).toBe(true);

    const withoutShots = FeatureAuditZ.safeParse({
      features: [{ key: 'F1', title: 'Export', status: 'ok', evidence: 'ok', fix_hint: '' }],
    });
    expect(withoutShots.success).toBe(true);
  });

  it('le JSON schema expose screenshots sans le rendre obligatoire', () => {
    const item = FEATURE_AUDIT_JSON_SCHEMA.properties.features.items;
    expect(item.properties).toHaveProperty('screenshots');
    expect(item.required).not.toContain('screenshots');
  });
});
