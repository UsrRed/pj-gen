import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractPdfText } from '../src/github/pdfInspector.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/pdf/hello.pdf');

describe('extractPdfText (T13, « pdfinspector »)', () => {
  it('extrait le texte d’un PDF valide', async () => {
    const text = await extractPdfText(FIXTURE);
    expect(text).toBe('Hello pj-gen');
  });

  it('ne lève jamais : fichier absent -> null', async () => {
    const text = await extractPdfText('/no/such/file.pdf');
    expect(text).toBeNull();
  });

  it('ne lève jamais : PDF corrompu -> null', async () => {
    const bad = path.join(fs.mkdtempSync('/tmp/pjgen-pdf-'), 'bad.pdf');
    fs.writeFileSync(bad, 'not a pdf at all');
    const text = await extractPdfText(bad);
    expect(text).toBeNull();
  });
});
