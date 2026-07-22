import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ArtifactNode } from '@pjgen/shared';
import { api } from '../api/client.js';
import { useStore } from '../store/useStore.js';
import { fmtSize } from '../lib/format.js';
import { T } from '../i18n/fr.js';

function Tree({ nodes, onOpen, depth = 0, selected }: { nodes: ArtifactNode[]; onOpen: (p: string) => void; depth?: number; selected: string | null }) {
  return (
    <ul className={depth ? 'ml-3 border-l border-zinc-800 pl-2' : ''}>
      {nodes.map((n) => (
        <li key={n.path}>
          {n.type === 'dir' ? (
            <details open={depth < 1}>
              <summary className="cursor-pointer select-none py-0.5 text-sm text-zinc-400 hover:text-zinc-200">📁 {n.name}</summary>
              {n.children && <Tree nodes={n.children} onOpen={onOpen} depth={depth + 1} selected={selected} />}
            </details>
          ) : (
            <button
              className={`flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-800/60 ${
                selected === n.path ? 'bg-zinc-800 text-indigo-300' : 'text-zinc-300'
              }`}
              onClick={() => onOpen(n.path)}
            >
              <span className="truncate">📄 {n.name}</span>
              <span className="shrink-0 text-[10px] text-zinc-600">{fmtSize(n.size)}</span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function WorkspaceBar({ projectId, workspacePath }: { projectId: string; workspacePath: string }) {
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(workspacePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (http/permissions): select the path so Ctrl+C works
      const el = document.getElementById('pjgen-workspace-path');
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };

  return (
    <div className="lg:col-span-2">
      <div className="card flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="text-xs text-zinc-500">{T.workspace} :</span>
        <code id="pjgen-workspace-path" className="min-w-0 flex-1 select-all truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300">
          {workspacePath}
        </code>
        <button className="btn-ghost !px-2.5 !py-1 !text-xs" onClick={() => void copy()}>
          {copied ? T.copied : `📋 ${T.copyPath}`}
        </button>
        <button
          className="btn-ghost !px-2.5 !py-1 !text-xs"
          title="Ouvre le gestionnaire de fichiers sur la machine qui héberge pj-gen"
          onClick={() => {
            setOpenError(null);
            void api.openFolder(projectId).catch((e) => setOpenError((e as Error).message));
          }}
        >
          📂 {T.openFolder}
        </button>
      </div>
      {openError && <div className="mt-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">{openError}</div>}
    </div>
  );
}

export function ArtifactsPanel({ projectId, workspacePath }: { projectId: string; workspacePath: string }) {
  const [tree, setTree] = useState<ArtifactNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const artifactsVersion = useStore((s) => s.artifactsVersion);

  useEffect(() => {
    void api
      .artifacts(projectId)
      .then((r) => setTree(r.tree))
      .catch((e) => setError((e as Error).message));
  }, [projectId, artifactsVersion]);

  useEffect(() => {
    if (!selected) return;
    void api
      .artifactFile(projectId, selected)
      .then((r) => {
        setContent(r.content);
        setTruncated(r.truncated);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [projectId, selected, artifactsVersion]);

  useEffect(() => {
    if (!selected && tree.length) {
      const docs = tree.find((n) => n.name === 'docs');
      const spec = docs?.children?.find((n) => n.name === 'SPEC.md');
      if (spec) setSelected(spec.path);
    }
  }, [tree, selected]);

  const isMd = selected?.endsWith('.md');

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <WorkspaceBar projectId={projectId} workspacePath={workspacePath} />
      <div className="card max-h-[calc(100vh-16rem)] overflow-y-auto p-3">
        {tree.length === 0 && <div className="text-sm text-zinc-600">{T.loading}</div>}
        <Tree nodes={tree} onOpen={setSelected} selected={selected} />
      </div>
      <div className="card max-h-[calc(100vh-16rem)] overflow-y-auto p-4">
        {error && <div className="text-sm text-red-400">{error}</div>}
        {!selected && !error && <div className="text-sm text-zinc-600">{T.noSpec}</div>}
        {selected && !error && (
          <>
            <div className="mb-2 border-b border-zinc-800 pb-2 font-mono text-xs text-zinc-500">
              {selected}
              {truncated ? ' (tronqué)' : ''}
            </div>
            {isMd ? (
              <div className="prose-chat">
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-300">{content}</pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
