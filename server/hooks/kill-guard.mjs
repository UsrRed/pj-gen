#!/usr/bin/env node
// PreToolUse hook (Bash): blocks pattern-based process kills inside generated-project
// sessions. A `pkill -9 -f "tsx"` from a build agent kills the pj-gen orchestrator
// itself (it runs as `tsx src/index.ts`) plus every other concurrent build — seen in
// production. Exit 2 = block the tool call; stderr is fed back to the model.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    const input = JSON.parse(raw);
    if (input.tool_name !== 'Bash') process.exit(0);
    cmd = String(input.tool_input?.command ?? '');
  } catch {
    process.exit(0);
  }
  const broadKill =
    /\b(pkill|killall5?)\b|\bkill\s+(-\w+\s+)*-1\b|\bpgrep\b[^|;&\n]*\|\s*(xargs\s+kill|while\b[\s\S]*\bkill\b)/;
  if (broadKill.test(cmd)) {
    process.stderr.write(
      'Commande bloquée: kill par motif de nom (pkill/killall) interdit — l’orchestrateur pj-gen (tsx src/index.ts) et d’autres builds tournent sur cette machine et seraient tués. ' +
        'Arrête uniquement TES process: mémorise le PID au lancement (ex. `npm run dev & echo $!`) puis `kill $PID`, ou libère un port avec `kill $(lsof -ti:PORT)`.'
    );
    process.exit(2);
  }
  process.exit(0);
});
