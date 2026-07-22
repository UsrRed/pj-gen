import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * commit-msg hook installed in every generated workspace: strips forbidden
 * attribution lines even if a session ignores the instructions.
 */
export const COMMIT_MSG_HOOK = `#!/bin/sh
# pj-gen: strip forbidden attribution trailers
tmp="$1.pjgen.tmp"
grep -viE '^[[:space:]]*(co-authored-by:.*(claude|anthropic)|.*generated with.*claude.*|.*généré avec.*claude.*)[[:space:]]*$' "$1" > "$tmp" || true
mv "$tmp" "$1"
exit 0
`;

export interface AuditIssue {
  sha: string;
  level: 'error' | 'warning';
  reason: string;
}

export interface AuditResult {
  ok: boolean;
  issues: AuditIssue[];
}

const EXPECTED_IDENTITY = { name: 'UsrRed', email: 'redefendeur@gmail.com' };
const FORBIDDEN_BODY = [/co-authored-by:.*?(claude|anthropic)/i, /generated with.*?claude/i, /généré avec.*?claude/i];

/**
 * Verifies every commit is authored/committed by UsrRed with no Claude attribution in messages.
 * Imported repositories (cloned from GitHub) carry foreign history: the local git config key
 * `pjgen.import-base` marks the clone point, and only commits AFTER it are audited.
 */
export async function auditCommits(workspace: string): Promise<AuditResult> {
  let importBase: string | null = null;
  try {
    const { stdout } = await execFileP('git', ['config', 'pjgen.import-base'], { cwd: workspace });
    importBase = stdout.trim() || null;
  } catch {
    /* not an imported repo */
  }
  const SEP = '--PJGEN-COMMIT--';
  const range = importBase ? [`${importBase}..HEAD`] : [];
  const { stdout } = await execFileP(
    'git',
    ['log', `--format=${SEP}%n%H%n%an <%ae>%n%cn <%ce>%n%B`, ...range],
    { cwd: workspace, maxBuffer: 16 * 1024 * 1024 }
  );
  const issues: AuditIssue[] = [];
  const expected = `${EXPECTED_IDENTITY.name} <${EXPECTED_IDENTITY.email}>`;
  for (const chunk of stdout.split(SEP)) {
    const lines = chunk.trim().split('\n');
    if (lines.length < 3 || !lines[0]) continue;
    const [sha, author, committer, ...body] = lines;
    const bodyText = body.join('\n');
    if (author.trim() !== expected) issues.push({ sha, level: 'error', reason: `author inattendu: ${author.trim()}` });
    if (committer.trim() !== expected) issues.push({ sha, level: 'error', reason: `committer inattendu: ${committer.trim()}` });
    for (const re of FORBIDDEN_BODY) {
      if (re.test(bodyText)) issues.push({ sha, level: 'error', reason: `attribution interdite dans le message (${re.source})` });
    }
  }
  return { ok: !issues.some((i) => i.level === 'error'), issues };
}
