export const ATTRIBUTION_RULES = `Attribution: les commits git sont authored par UsrRed <redefendeur@gmail.com> (déjà configuré). N'ajoute JAMAIS de trailer "Co-Authored-By", de mention "Generated with Claude Code" ni aucune référence à Claude/Anthropic comme auteur, dans les commits, le code, les docs ou les fichiers générés.`;

export const TOKEN_ECONOMY_RULES = `Économie de contexte: lis uniquement les fichiers nécessaires à ta consigne (ou explicitement nommés). Pas d'exploration large du dépôt, pas de relecture de gros fichiers déjà connus. L'état des tâches vit dans docs/tasks.json, pas dans la conversation. Sois direct et concis.`;

export const LANGUAGE_RULES = `Langue: code, identifiants et messages de commit en anglais; documents destinés à l'utilisateur (README, SPEC) en français.`;

export const SCOPE_RULES = `Périmètre: ne modifie rien en dehors du répertoire courant du projet.`;

export const NAVIGATION_RULES = `Navigation: docs/ARCHITECTURE.md est la CARTE du dépôt — consulte-la pour localiser un fichier au lieu de chercher. INTERDIT: grep/rg récursif sur tout le dépôt, find global, listing/lecture de répertoires entiers. docs/INTERFACES.md recense les contrats d'interface clés (signatures, schémas API/WS, types partagés): consulte-le au lieu de rouvrir les sources pour retrouver une signature; si tu modifies un contrat, mets ce fichier à jour dans le même commit et note le changement dans docs/PROGRESS.md.`;

export const PROCESS_HYGIENE_RULES = `Processus: n'utilise JAMAIS pkill, killall ni aucun kill par motif de nom (l'orchestrateur qui t'a lancé tourne sur cette machine via "tsx src/index.ts" — un pkill -f tsx/node/server/vite le tue, ainsi que les autres builds). Pour arrêter un process que tu as lancé: mémorise son PID ($!) et fais kill $PID. Pour libérer un port: kill $(lsof -ti:PORT). Lance tes serveurs de dev sur des ports dédiés et arrête-les par PID ou par port, jamais par nom.`;

export function budgetRule(caps: { maxTurns: number; timeoutMs: number }): string {
  const minutes = Math.round(caps.timeoutMs / 60_000);
  return `Budget: cette session est plafonnée à ~${caps.maxTurns} tours et ${minutes} minutes par un superviseur qui la coupe NET au-delà (travail non committé perdu). Planifie pour finir AVANT: committe tôt et souvent (un commit par unité cohérente), garde ~20 % de marge pour stabiliser et committer, et ne lance pas une exploration ou un chantier que ce budget ne permet pas de terminer.`;
}

/** Appended (via --append-system-prompt) to every build/deploy session; pass the step caps for tool sessions so the model knows its budget. */
export function commonSystemPrompt(caps?: { maxTurns: number; timeoutMs: number }): string {
  const rules = [ATTRIBUTION_RULES, TOKEN_ECONOMY_RULES, LANGUAGE_RULES, SCOPE_RULES, PROCESS_HYGIENE_RULES, NAVIGATION_RULES];
  if (caps) rules.push(budgetRule(caps));
  return ['Règles impératives:', ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n');
}

export function generatedClaudeMd(title: string): string {
  return `# ${title}

Projet généré automatiquement par pj-gen.

## Conventions impératives
- ${ATTRIBUTION_RULES}
- ${TOKEN_ECONOMY_RULES}
- ${LANGUAGE_RULES}
- ${PROCESS_HYGIENE_RULES}
- ${NAVIGATION_RULES}
- Commits atomiques par tâche: \`feat(Txx): ...\` ; scaffolding: \`chore: ...\` ; docs: \`docs: ...\`.

## Fichiers de référence
- \`docs/SPEC.md\` — spécification validée (source de vérité fonctionnelle)
- \`docs/ARCHITECTURE.md\` — architecture et stack (carte du dépôt)
- \`docs/INTERFACES.md\` — contrats d'interface figés (signatures, schémas API/WS)
- \`docs/tasks.json\` — liste des tâches et statuts (géré par l'orchestrateur, ne pas modifier)
- \`docs/PROGRESS.md\` — journal de progression
`;
}
