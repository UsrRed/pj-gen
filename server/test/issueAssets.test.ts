import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadIssueAssets, extractAttachmentUrls } from '../src/github/issueAssets.js';

describe('extractAttachmentUrls', () => {
  it('finds github attachment URLs in markdown, html and prose', () => {
    const body = [
      'Le bouton est cassé, voir la capture :',
      '![bug](https://github.com/user-attachments/assets/aaaa1111-2222-3333-4444-555566667777)',
      '<img src="https://user-images.githubusercontent.com/12345/999-screen.png">',
      'et le log : [log.zip](https://github.com/UsrRed/immoExpert/files/123/log.zip).',
      'nouveau format fichier https://github.com/user-attachments/files/456/trace.txt,',
    ].join('\n');
    expect(extractAttachmentUrls(body)).toEqual([
      'https://github.com/user-attachments/assets/aaaa1111-2222-3333-4444-555566667777',
      'https://user-images.githubusercontent.com/12345/999-screen.png',
      'https://github.com/UsrRed/immoExpert/files/123/log.zip',
      'https://github.com/user-attachments/files/456/trace.txt',
    ]);
  });

  it('ignores non-attachment links, dedupes and caps at 8', () => {
    const dup = 'https://github.com/user-attachments/assets/bbbb1111-2222-3333-4444-555566667777';
    expect(extractAttachmentUrls(`voir https://github.com/UsrRed/immoExpert/issues/13 et ${dup} puis ${dup}`)).toEqual([dup]);
    const many = Array.from({ length: 12 }, (_, i) => `https://github.com/user-attachments/assets/cccc0000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    expect(extractAttachmentUrls(many.join(' '))).toHaveLength(8);
  });

  it('returns empty on plain-text bodies', () => {
    expect(extractAttachmentUrls('Le scraper échoue depuis hier, rien dans les logs.')).toEqual([]);
  });
});

describe('downloadIssueAssets', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pjgen-assets-'));
  afterEach(() => vi.unstubAllGlobals());

  it('writes sanitized filenames with the extension from content-type, and sends the token only to github.com', async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return new Response(Buffer.from('PNGDATA'), { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const dir = tmp();
    const res = await downloadIssueAssets(
      ['https://github.com/user-attachments/assets/aaaa1111', 'https://user-images.githubusercontent.com/1/shot.png'],
      dir,
      'tok-123'
    );
    expect(res.map((r) => r.ok)).toEqual([true, true]);
    expect(res[0].file).toBe(path.join(dir, 'piece-jointe-1.png'));
    expect(fs.readFileSync(res[1].file!, 'utf8')).toBe('PNGDATA');
    expect(calls[0].auth).toBe('Bearer tok-123');
    expect(calls[1].auth).toBeUndefined();
  });

  it('degrades per file: HTTP errors and oversized bodies fail without blocking the others', async () => {
    const big = Buffer.alloc(16 * 1024 * 1024);
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('missing')) return new Response('nope', { status: 404 });
      if (url.endsWith('huge.bin')) return new Response(big, { status: 200 });
      return new Response(Buffer.from('ok'), { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const res = await downloadIssueAssets(
      [
        'https://github.com/user-attachments/assets/missing',
        'https://github.com/user-attachments/files/1/huge.bin',
        'https://github.com/user-attachments/files/2/notes.txt',
      ],
      tmp(),
      null
    );
    expect(res.map((r) => r.ok)).toEqual([false, false, true]);
    expect(res[0].error).toBe('HTTP 404');
    expect(res[1].error).toBe('fichier trop volumineux');
    expect(res[2].file).toMatch(/piece-jointe-3\.txt$/);
  });
});
