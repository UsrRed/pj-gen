import { ZERO_USAGE, type RunHandle, type RunHooks, type RunResult, type RunnerFn, type SessionSpec } from './types.js';

export interface FakeOutcome {
  /** Display lines streamed before the result (simulates live logs). */
  events?: string[];
  result: Partial<RunResult> & { outcome: 'success' | 'failure' };
  delayMs?: number;
}

export type FakeScript = (spec: SessionSpec, callIndex: number) => FakeOutcome;

function schemaProps(spec: SessionSpec): Set<string> {
  const props = (spec.jsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return new Set(props ? Object.keys(props) : []);
}

/** Plausible canned outputs so the whole pipeline can be demoed with zero quota (PJGEN_FAKE_CLI=1). */
export const defaultFakeScript: FakeScript = (spec) => {
  const props = schemaProps(spec);
  if (props.has('reply_markdown')) {
    return {
      delayMs: 700,
      result: {
        outcome: 'success',
        structured: {
          reply_markdown:
            "Bien reçu ! (mode simulation)\n\nQuelques questions pour cadrer le projet :\n1. Qui sont les utilisateurs cibles ?\n2. As-tu une préférence de stack ?\n\nQuand tu es prêt, clique sur **Générer le SPEC**.",
          open_questions: ['Qui sont les utilisateurs cibles ?', 'Préférence de stack ?'],
          ready_for_spec: true,
        },
      },
    };
  }
  if (props.has('spec_markdown') && props.has('architecture_markdown')) {
    return {
      delayMs: 800,
      result: {
        outcome: 'success',
        structured: {
          title: 'Dépôt importé (simulation)',
          spec_markdown:
            '# SPEC — Dépôt importé (simulation)\n\n## Objectif\nSpécification reconstruite depuis le code existant (mode simulation).\n\n## Fonctionnalités\n- F1: fonctionnalité observée — critère: présente dans le code.\n\n## Hors périmètre\n- Tout le reste.',
          architecture_markdown: '# Architecture (import, simulation)\n\n- `src/` — code existant\n- `test/` — tests natifs',
          interfaces_markdown: '# Interfaces (simulation)\n- `main()` — point d’entrée',
          stack: {
            language: 'javascript',
            framework: 'node',
            package_manager: 'npm',
            install_cmd: '',
            build_cmd: '',
            test_cmd: 'node -e "process.exit(0)"',
            run_cmd: '',
          },
        },
      },
    };
  }
  if (props.has('spec_markdown')) {
    return {
      delayMs: 900,
      result: {
        outcome: 'success',
        structured: {
          title: 'Projet simulé',
          spec_markdown:
            '# SPEC — Projet simulé\n\n## Objectif\nProjet de démonstration (mode simulation, aucun appel réel).\n\n## Fonctionnalités\n- F1: fonctionnalité principale — critère: ça marche.\n- F2: sortie utilisateur claire.\n\n## Hors périmètre\n- Tout le reste.',
        },
      },
    };
  }
  if (props.has('architecture_markdown')) {
    return {
      delayMs: 900,
      result: {
        outcome: 'success',
        structured: {
          architecture_markdown:
            '# Architecture (simulation)\n\nCLI Node.js sans dépendance externe.\n\n- `src/cli.js` — point d’entrée\n- `test/` — tests natifs `node --test`',
          stack: {
            language: 'javascript',
            framework: 'node',
            package_manager: 'npm',
            install_cmd: 'npm install',
            build_cmd: '',
            test_cmd: 'node --test',
            run_cmd: 'node src/cli.js',
          },
          risks: ['Aucun (simulation)'],
        },
      },
    };
  }
  if (props.has('clarification_question')) {
    return {
      delayMs: 500,
      result: {
        outcome: 'success',
        structured: {
          actionable: true,
          clarification_question: '',
          title: 'Micro-modification simulée',
          description: 'Appliquer la petite modification demandée (simulation).',
          files_hint: ['src/cli.js'],
          acceptance: ['le changement est visible (simulation)'],
        },
      },
    };
  }
  if (props.has('benchmark_markdown')) {
    return {
      delayMs: 600,
      result: {
        outcome: 'success',
        structured: {
          applicable: true,
          benchmark_markdown:
            '# Benchmark design (simulation)\n\n- Produit A: palette sombre #101014/#f5f5f5, accent orange; layout 2 colonnes; typographie grotesque serrée.\n- Produit B: fond clair, accent vert émeraude; cartes denses, tableaux dominants.\n\nSynthèse: les bons produits du domaine assument une palette tranchée et une hiérarchie typographique nette.',
        },
      },
    };
  }
  if (props.has('mockup_html')) {
    return {
      delayMs: 700,
      result: {
        outcome: 'success',
        structured: {
          applicable: true,
          mockup_html: `<html><head><meta charset="utf-8"><title>Maquette simulée</title><style>
:root{--bg:#0a0a0a;--fg:#eeeeee;--accent:#6366f1;--muted:#8a8a8a;--radius:12px}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0}
.hero{padding:4rem 2rem;text-align:center}
.hero h1{font-size:2.2rem;letter-spacing:-0.02em}
.hero p{color:var(--muted);max-width:40rem;margin:1rem auto}
.cta{display:inline-block;background:var(--accent);color:#fff;padding:.75rem 1.5rem;border-radius:var(--radius)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;padding:2rem}
.card{border:1px solid #262626;border-radius:var(--radius);padding:1.25rem;background:#121212}
.empty{padding:3rem;text-align:center;color:var(--muted);border:1px dashed #333;border-radius:var(--radius);margin:2rem}
</style></head><body>
<section class="hero"><h1>Maquette simulée</h1><p>Vue principale du produit fini — générée en mode simulation par l'étape design du pipeline.</p><a class="cta" href="#">Action principale</a></section>
<section class="grid"><div class="card"><h3>Élément différenciant</h3><p>Représentation visuelle de l'intention.</p></div><div class="card"><h3>État vide</h3><p>Exemple d'état vide soigné.</p></div><div class="card"><h3>Erreur</h3><p>Exemple d'état d'erreur lisible.</p></div></section>
<div class="empty">Aucune donnée pour le moment — commence par créer un élément.</div>
</body></html>`,
          design_notes_markdown:
            '# Design system (simulation)\n- Palette: fond #0a0a0a, texte #eeeeee, accent #6366f1, muted #8a8a8a\n- Typo: system-ui, titres -0.02em\n- Rayons: 12px; cartes #121212 bord #262626\n- Motion: transitions 150ms ease-out',
        },
      },
    };
  }
  if (props.has('features')) {
    return {
      delayMs: 700,
      result: {
        outcome: 'success',
        structured: {
          features: [
            { key: 'F1', title: 'Fonctionnalité principale', status: 'ok', evidence: 'simulation — câblée de bout en bout', fix_hint: '' },
            { key: 'F2', title: 'Sortie utilisateur', status: 'ok', evidence: 'simulation — rendu constaté', fix_hint: '' },
          ],
        },
      },
    };
  }
  if (props.has('tasks')) {
    return {
      delayMs: 900,
      result: {
        outcome: 'success',
        structured: {
          tasks: [
            { task_key: 'T01', title: 'Squelette CLI', description: 'Créer le point d’entrée CLI.', files_hint: ['src/cli.js'], acceptance: ['la commande s’exécute'], depends_on: [] },
            { task_key: 'T02', title: 'Logique métier', description: 'Implémenter la fonctionnalité principale.', files_hint: ['src/core.js'], acceptance: ['tests unitaires verts'], depends_on: ['T01'] },
            { task_key: 'T03', title: 'Sortie utilisateur', description: 'Formater la sortie.', files_hint: ['src/cli.js'], acceptance: ['sortie lisible'], depends_on: ['T02'] },
          ],
        },
      },
    };
  }
  return {
    delayMs: 1200,
    events: ['● Analyse de la consigne (simulation)', '→ Bash npm test', '✓ tests verts (simulation)'],
    result: { outcome: 'success', resultText: 'Étape simulée avec succès.', numTurns: 3 },
  };
};

export function createFakeRunner(script: FakeScript = defaultFakeScript): RunnerFn {
  let callIndex = 0;

  return function run(spec: SessionSpec, hooks: RunHooks = {}): RunHandle {
    const outcome = script(spec, callIndex++);
    const delay = outcome.delayMs ?? 500;
    let canceled: 'canceled' | 'timeout' | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    let finish: () => void = () => undefined;

    const result = new Promise<RunResult>((resolve) => {
      finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (canceled) {
          resolve({
            outcome: 'failure',
            sessionId: spec.sessionId,
            resultText: '',
            numTurns: 0,
            costUsd: 0,
            usage: ZERO_USAGE,
            durationMs: delay,
            failure: { kind: canceled === 'timeout' ? 'timeout' : 'canceled', message: 'Session simulée interrompue' },
          });
          return;
        }
        const r = outcome.result;
        resolve({
          outcome: r.outcome,
          sessionId: r.sessionId ?? spec.sessionId,
          resultText: r.resultText ?? (r.structured ? JSON.stringify(r.structured) : 'OK (simulation)'),
          structured: r.structured,
          numTurns: r.numTurns ?? 1,
          costUsd: r.costUsd ?? 0.0123,
          usage: r.usage ?? { inputTokens: 1200, outputTokens: 450, cacheCreationTokens: 3000, cacheReadTokens: 8000 },
          rateLimitInfo: r.rateLimitInfo ?? {
            status: 'allowed',
            resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600,
            rateLimitType: 'five_hour',
          },
          durationMs: delay,
          failure: r.failure,
        });
      };

      hooks.onLog?.({ kind: 'meta', line: 'fake:init', display: `▶ session ${spec.sessionId} — modèle ${spec.model} (simulation)` });
      const events = outcome.events ?? [];
      let i = 0;
      const stepDelay = Math.max(80, Math.floor(delay / (events.length + 1)));
      const emitNext = () => {
        if (canceled) return finish();
        if (i < events.length) {
          hooks.onLog?.({ kind: 'meta', line: `fake:${i}`, display: events[i] });
          i++;
          timer = setTimeout(emitNext, stepDelay);
        } else {
          timer = setTimeout(finish, stepDelay);
        }
      };
      timer = setTimeout(emitNext, stepDelay);
    });

    return {
      pid: null,
      result,
      cancel: (reason) => {
        if (settled) return;
        canceled = reason;
        finish();
      },
    };
  };
}
