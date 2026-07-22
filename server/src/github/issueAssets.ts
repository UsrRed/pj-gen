import fs from 'node:fs';
import path from 'node:path';

/** Attachments per issue: enough for screenshots/mockups, bounded against abuse. */
const MAX_ASSETS = 8;
const MAX_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/** GitHub-hosted attachment URLs found in an issue body (markdown or HTML). */
const ATTACHMENT_URL_RE =
  /https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/[^\s)"'<>\]]+|(?:private-)?user-images\.githubusercontent\.com\/[^\s)"'<>\]]+|github\.com\/[^\s)"'<>\]]+\/files\/\d+\/[^\s)"'<>\]]+)/g;

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'text/plain': 'txt',
};

export interface AssetResult {
  url: string;
  /** Absolute local path — set only when ok. */
  file: string | null;
  ok: boolean;
  error?: string;
}

/** Extract GitHub attachment URLs from an issue body. Deduped, capped at MAX_ASSETS. */
export function extractAttachmentUrls(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(ATTACHMENT_URL_RE)) {
    // Markdown/prose often glues punctuation to the URL.
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(url)) seen.add(url);
    if (seen.size >= MAX_ASSETS) break;
  }
  return [...seen];
}

function extensionFor(url: string, contentType: string | null): string {
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const last = new URL(url).pathname.split('/').pop() ?? '';
  const ext = last.includes('.') ? last.split('.').pop()! : '';
  // Attacker-controlled filename: keep only a short alphanumeric extension.
  return /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : 'bin';
}

/**
 * Download issue attachments into destDir (recreated empty). Filenames are
 * sanitized (`piece-jointe-N.ext`) — original names are untrusted input.
 * The gh token is only sent to github.com (undici drops Authorization on
 * cross-origin redirects, so the signed S3 hop never sees it).
 */
export async function downloadIssueAssets(urls: string[], destDir: string, token: string | null): Promise<AssetResult[]> {
  if (!urls.length) return [];
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const results: AssetResult[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      const headers: Record<string, string> = { 'User-Agent': 'pj-gen' };
      if (token && new URL(url).hostname === 'github.com') headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        results.push({ url, file: null, ok: false, error: `HTTP ${res.status}` });
        continue;
      }
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > MAX_BYTES) {
        results.push({ url, file: null, ok: false, error: 'fichier trop volumineux' });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) {
        results.push({ url, file: null, ok: false, error: 'fichier trop volumineux' });
        continue;
      }
      const file = path.join(destDir, `piece-jointe-${i + 1}.${extensionFor(url, res.headers.get('content-type'))}`);
      fs.writeFileSync(file, buf);
      results.push({ url, file, ok: true });
    } catch (e) {
      results.push({ url, file: null, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
