import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { ConsoleStatusDto } from '@pjgen/shared';
import { api, API_BASE } from '../api/client.js';
import { ConfirmButton } from '../components/ConfirmButton.js';
import { T } from '../i18n/fr.js';

/** One-click commands typed into the shell — the console exists mostly for these. */
const QUICK_COMMANDS: { label: string; cmd: string }[] = [
  { label: 'gh auth login', cmd: 'gh auth login -h github.com -p https -w' },
  { label: 'gh auth status', cmd: 'gh auth status' },
  { label: 'claude auth login', cmd: 'claude auth login' },
  { label: 'claude auth status', cmd: 'claude auth status' },
];

/** Interactive claude session pre-briefed with docs/MAINTENANCE.md (DB, API, repos, method). */
const MAINTENANCE_CMD =
  "cd /app && claude 'Lis /app/docs/MAINTENANCE.md puis diagnostique ce qui bloque dans pj-gen et les projets (issues, builds, auth, push), explique-le moi et propose/applique les correctifs.'";

/** Keystrokes are coalesced for this long before one POST — a paste or a fast typist = one request. */
const INPUT_FLUSH_MS = 8;

export function ConsolePage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<ConsoleStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const [pasteBox, setPasteBox] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const assistPending = useRef(params.get('debloquer') === '1');

  const start = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    setError(null);
    void api
      .consoleStart(term.cols, term.rows)
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    term.focus();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#09090b' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener')));
    term.open(host);
    fit.fit();
    termRef.current = term;

    let pending = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const input = term.onData((data) => {
      pending += data;
      flushTimer ??= setTimeout(() => {
        const chunk = pending;
        pending = '';
        flushTimer = null;
        void api.consoleInput(chunk).catch((e: Error) => setError(e.message));
      }, INPUT_FLUSH_MS);
    });

    let lastSize = '';
    const sendSize = () => {
      fit.fit();
      const size = `${term.cols}x${term.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      void api.consoleResize(term.cols, term.rows).catch(() => undefined);
    };
    const ro = new ResizeObserver(() => sendSize());
    ro.observe(host);

    let autoStarted = false;
    const es = new EventSource(`${API_BASE}/api/console/stream`);
    es.addEventListener('snapshot', (ev) => {
      const { data, status: s } = JSON.parse((ev as MessageEvent).data) as { data: string; status: ConsoleStatusDto };
      setStatus(s);
      setError(null);
      term.reset();
      term.write(data);
      // First visit: open the shell straight away; after an exit, wait for an explicit relaunch.
      if (s.available && !s.running && s.startedAt === null && !autoStarted) {
        autoStarted = true;
        start();
      } else if (s.running) {
        lastSize = '';
        sendSize();
      }
    });
    es.addEventListener('output', (ev) => term.write(JSON.parse((ev as MessageEvent).data) as string));
    es.addEventListener('started', (ev) => {
      term.reset();
      setStatus(JSON.parse((ev as MessageEvent).data) as ConsoleStatusDto);
    });
    es.addEventListener('exit', (ev) => {
      const s = JSON.parse((ev as MessageEvent).data) as ConsoleStatusDto;
      setStatus(s);
      term.write(`\r\n\x1b[2m${T.consoleExited(s.exitCode)}\x1b[0m\r\n`);
    });
    es.onerror = () => {
      // A refused guard (403) closes the stream for good — surface the server's reason.
      if (es.readyState === EventSource.CLOSED) {
        void api.consoleStatus().catch((e: Error) => setError(e.message));
      }
    };
    term.focus();

    return () => {
      es.close();
      ro.disconnect();
      input.dispose();
      if (flushTimer) clearTimeout(flushTimer);
      term.dispose();
      termRef.current = null;
    };
  }, [start]);

  const running = status?.running ?? false;

  // « 🛠 Débloquer » (header) lands here with ?debloquer=1: launch the maintenance session once the shell is up.
  useEffect(() => {
    if (!assistPending.current || !running) return;
    assistPending.current = false;
    setParams({}, { replace: true });
    // Small delay: the freshly spawned bash must be ready to read the line.
    const t = setTimeout(() => void api.consoleInput(`${MAINTENANCE_CMD}\r`).catch((e: Error) => setError(e.message)), 400);
    return () => clearTimeout(t);
  }, [running, setParams]);

  const type = (cmd: string) => {
    void api.consoleInput(`${cmd}\r`).catch((e: Error) => setError(e.message));
    termRef.current?.focus();
  };

  const sendPaste = (text: string) => {
    const term = termRef.current;
    if (!term || !text) return;
    // term.paste() applies bracketed-paste mode and routes through onData like a real paste.
    term.paste(text);
    term.focus();
  };

  const paste = () => {
    // navigator.clipboard is undefined outside secure contexts (plain http) and readText is
    // denied without permission — both fall back to a manual paste box.
    if (!navigator.clipboard?.readText) {
      setPasteBox('');
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => sendPaste(text))
      .catch(() => setPasteBox(''));
  };

  const recheck = () => {
    setAuthMsg(null);
    void api
      .consoleRecheckAuth()
      .then((a) => setAuthMsg(a.ok ? T.consoleAuthOk(a.detail) : T.consoleAuthKo(a.detail)))
      .catch((e: Error) => setAuthMsg(e.message));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">{T.consoleTitle}</h1>
        <span className="text-xs text-zinc-500">
          {running ? T.consoleRunning(status?.pid ?? null) : status?.available === false ? T.consoleUnavailable : T.consoleStopped}
        </span>
      </div>
      <p className="text-sm text-zinc-400">{T.consoleHint}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary !px-2.5 !py-1 text-xs" disabled={!running} title={T.consoleAssist} onClick={() => type(MAINTENANCE_CMD)}>
          🛠 {T.unblock}
        </button>
        {QUICK_COMMANDS.map((q) => (
          <button key={q.label} className="btn-ghost !px-2.5 !py-1 font-mono text-xs" disabled={!running} onClick={() => type(q.cmd)}>
            {q.label}
          </button>
        ))}
        <button className="btn-ghost !px-2.5 !py-1 text-xs" disabled={!running} onClick={paste}>
          📋 {T.consolePaste}
        </button>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={recheck}>
          {T.consoleRecheckAuth}
        </button>
        <span className="ml-auto flex gap-2">
          {running ? (
            <ConfirmButton
              label={T.consoleKill}
              confirmLabel={T.consoleKillConfirm}
              className="btn-danger !px-2.5 !py-1 text-xs"
              onConfirm={() => void api.consoleKill().catch((e: Error) => setError(e.message))}
            />
          ) : (
            <button className="btn-primary !px-2.5 !py-1 text-xs" disabled={status?.available === false} onClick={start}>
              {status?.startedAt ? T.consoleRestart : T.consoleStart}
            </button>
          )}
        </span>
      </div>

      {authMsg && <div className="text-xs text-zinc-300">{authMsg}</div>}
      {(error || status?.reason) && <div className="text-sm text-red-400">⚠️ {error ?? status?.reason}</div>}

      {pasteBox !== null && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-400">{T.consolePasteManual}</div>
          <textarea
            autoFocus
            className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs"
            rows={4}
            value={pasteBox}
            onChange={(e) => setPasteBox(e.target.value)}
          />
          <span className="flex gap-2">
            <button
              className="btn-primary !px-2.5 !py-1 text-xs"
              disabled={!pasteBox}
              onClick={() => {
                sendPaste(pasteBox);
                setPasteBox(null);
              }}
            >
              {T.consolePasteSend}
            </button>
            <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={() => setPasteBox(null)}>
              {T.consolePasteCancel}
            </button>
          </span>
        </div>
      )}

      <div className="card overflow-hidden p-2">
        <div ref={hostRef} className="h-[65vh] min-h-64 w-full" />
      </div>
    </div>
  );
}
