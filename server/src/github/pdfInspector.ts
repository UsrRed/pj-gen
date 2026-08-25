import fs from 'node:fs';
import { PDFParse } from 'pdf-parse';

/** Bounds how much PDF text lands in a cadrage/SPEC prompt — same order as MAX_COMMENT_CHARS in issuePoller.ts. */
const MAX_CHARS = 4_000;

/**
 * Best-effort text extraction from a local PDF (issue/cadrage attachment), for
 * cadrage/SPEC context (F1/F9). No MCP, no network, no credential — a plain
 * server-side utility. Never throws: a corrupt/scanned/encrypted PDF just
 * yields no text, and the pipeline continues with the attachment path alone.
 */
export async function extractPdfText(filePath: string): Promise<string | null> {
  let parser: PDFParse | null = null;
  try {
    const data = fs.readFileSync(filePath);
    parser = new PDFParse({ data });
    const result = await parser.getText({ pageJoiner: '\n' });
    const text = result.text.replace(/\s+\n/g, '\n').trim();
    if (!text) return null;
    return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[…tronqué]` : text;
  } catch {
    return null;
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}
