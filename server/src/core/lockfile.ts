import fs from 'node:fs';
import path from 'node:path';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Exclusive pid lockfile: prevents two orchestrators from double-scheduling. */
export function acquireLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'pj-gen.lock');
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch {
    const existing = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    if (!Number.isNaN(existing) && existing !== process.pid && pidAlive(existing)) {
      throw new Error(`pj-gen tourne déjà (pid ${existing}) — lockfile: ${lockPath}`);
    }
    fs.writeFileSync(lockPath, String(process.pid));
  }
  return () => {
    try {
      const content = fs.readFileSync(lockPath, 'utf8').trim();
      if (content === String(process.pid)) fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  };
}
