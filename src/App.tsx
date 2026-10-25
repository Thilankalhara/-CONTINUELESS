import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowRight, BookOpen, Check, CheckCircle2, Copy,
  ChevronDown, CircleDot, Clock3, Code2, FileCode2, FilePlus2, FolderGit2, GitBranch,
  GitCommitHorizontal, History, Lightbulb, LoaderCircle, Plus, RefreshCw, Search,
  ShieldAlert, Sparkles, X,
} from 'lucide-react';

type EntryKind = 'decision' | 'checkpoint' | 'bug' | 'work' | 'failed';
type Entry = { id: number; kind: EntryKind; title: string; body: string; created_at: string };
type Project = { id: number; name: string; root_path: string; indexed_at: string | null; file_count: number; entry_count: number };
type Event = { id: number; kind: string; summary: string; details: string; created_at: string };
type FileChange = { relative_path: string; change_type: 'added' | 'changed' | 'removed'; before_content: string; after_content: string };
type DiffLine = { type: 'context' | 'added' | 'removed'; text: string; oldLine?: number; newLine?: number };
type Dashboard = {
  project: Project; git: {
    available: boolean; branch: string | null; changedFiles: number;
    workingTreeChanges: Array<{ status: string; path: string }>;
    lastCommit: { hash: string; subject: string; age: string } | null;
  };
  events: Event[]; entries: Entry[]; stats: { files: number; decisions: number; bugs: number; checkpoints: number };
};
type SearchResult = { id: number; kind: string; title: string; excerpt: string; path: string };

const kinds: Array<{ id: EntryKind; label: string; icon: typeof Lightbulb }> = [
  { id: 'decision', label: 'Decision', icon: Lightbulb },
  { id: 'checkpoint', label: 'Checkpoint', icon: CircleDot },
  { id: 'bug', label: 'Open bug', icon: AlertCircle },
  { id: 'work', label: 'Completed', icon: CheckCircle2 },
  { id: 'failed', label: 'Failed task', icon: ShieldAlert },
];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data as T;
}

function timeAgo(date: string) {
  const timestamp = new Date(date.includes('T') ? date : `${date.replace(' ', 'T')}Z`).getTime();
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function highlightExcerpt(excerpt: string) {
  let highlighted = false;
  return excerpt.split(/(<mark>|<\/mark>)/g).map((part, index) => {
    if (part === '<mark>') { highlighted = true; return null; }
    if (part === '</mark>') { highlighted = false; return null; }
    return highlighted ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>;
  });
}

function gitChangeClass(status: string) {
  if (status === '??' || status.includes('A')) return 'added';
  if (status.includes('D')) return 'removed';
  return 'changed';
}

function buildDiffLines(before: string, after: string): DiffLine[] {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const columns = newLines.length + 1;
  if ((oldLines.length + 1) * columns > 1_000_000) {
    return [
      ...oldLines.map((text, index) => ({ type: 'removed' as const, text, oldLine: index + 1 })),
      ...newLines.map((text, index) => ({ type: 'added' as const, text, newLine: index + 1 })),
    ];
  }
  const lengths = new Uint32Array((oldLines.length + 1) * columns);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * columns + newIndex;
      lengths[index] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[(oldIndex + 1) * columns + newIndex + 1] + 1
        : Math.max(lengths[(oldIndex + 1) * columns + newIndex], lengths[index + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ type: 'context', text: oldLines[oldIndex], oldLine: oldIndex + 1, newLine: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (lengths[(oldIndex + 1) * columns + newIndex] >= lengths[oldIndex * columns + newIndex + 1]) {
      lines.push({ type: 'removed', text: oldLines[oldIndex], oldLine: oldIndex + 1 });
      oldIndex += 1;
    } else {
      lines.push({ type: 'added', text: newLines[newIndex], newLine: newIndex + 1 });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    lines.push({ type: 'removed', text: oldLines[oldIndex], oldLine: oldIndex + 1 });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    lines.push({ type: 'added', text: newLines[newIndex], newLine: newIndex + 1 });
    newIndex += 1;
  }
  return lines;
}

function renderHistoryDetails(details: string, onOpenFile: (path: string, eventId: number) => void, eventId: number) {
  let action: 'added' | 'changed' | 'removed' | null = null;
  return details.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const heading = line.match(/^(Added|Changed|Removed):(?:\s*(.*))?$/);
    if (heading) {
      action = heading[1].toLowerCase() as 'added' | 'changed' | 'removed';
      const paths = heading[2]?.split(',').map(file => file.trim()).filter(Boolean) ?? [];
      return <span className={`history-file-group history-file-${action}`} key={index}>
        <strong>{heading[1]}</strong>
        {paths.map((file, fileIndex) => <button className="history-file-path" onClick={() => onOpenFile(file, eventId)} key={`${file}-${fileIndex}`}>{file}</button>)}
      </span>;
    }
    if (action && line.trimStart().startsWith('- ')) {
      const file = line.trim().slice(2);
      return <button className={`history-file-path history-file-${action}`} onClick={() => onOpenFile(file, eventId)} key={index}>{file}</button>;
    }
    action = null;
    return <span className="history-detail-line" key={index}>{line}</span>;
  });
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [dialog, setDialog] = useState(false);
  const [fileChange, setFileChange] = useState<FileChange | null>(null);
  const [fileDiffLines, setFileDiffLines] = useState<DiffLine[]>([]);
  const [fileDiffLoading, setFileDiffLoading] = useState(false);
  const [fileDiffError, setFileDiffError] = useState('');
  const [fileDiffCopyError, setFileDiffCopyError] = useState('');
  const fileDiffRequestId = useRef(0);
  const [kind, setKind] = useState<EntryKind>('checkpoint');
  const [entryTitle, setEntryTitle] = useState('');
  const [entryBody, setEntryBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  async function loadProjects(preferred?: number) {
    const rows = await request<Project[]>('/api/projects');
    setProjects(rows);
    const next = preferred ?? (rows.some(project => project.id === activeId) ? activeId : rows[0]?.id ?? null);
    setActiveId(next);
    return next;
  }

  async function loadDashboard(id: number) {
    const data = await request<Dashboard>(`/api/projects/${id}/dashboard`);
    setDashboard(data);
    setProjects(current => current.map(project => project.id === id ? { ...project, ...data.project, file_count: data.stats.files } : project));
  }

  useEffect(() => {
    loadProjects().catch(reason => setError(reason.message));
  }, []);

  useEffect(() => {
    if (activeId === null) { setDashboard(null); return; }
    const syncProject = async () => {
      try {
        await request(`/api/projects/${activeId}/index`, { method: 'POST' });
        await loadDashboard(activeId);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Could not sync project.');
      }
    };
    void syncProject();
    const refreshTimer = window.setInterval(syncProject, 45000);
    return () => window.clearInterval(refreshTimer);
  }, [activeId]);

  useEffect(() => {
    if (search.trim().length < 2 || activeId === null) { setResults([]); return; }
    const timer = window.setTimeout(() => {
      request<{ results: SearchResult[] }>(`/api/projects/${activeId}/search?q=${encodeURIComponent(search)}`)
        .then(data => setResults(data.results))
        .catch(reason => setError(reason.message));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [search, activeId]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.search-input')?.focus();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  useEffect(() => {
    if (!fileChange) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFileChange();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [fileChange]);

  async function connectProject(event: FormEvent) {
    event.preventDefault();
    if (!folderPath.trim()) return;
    setBusy(true); setError('');
    try {
      const project = await request<Project & { indexing: { scanned: number } }>('/api/projects', { method: 'POST', body: JSON.stringify({ path: folderPath }) });
      await loadProjects(project.id);
      setFolderPath('');
      setNotice(`Indexed ${project.indexing.scanned} files`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not connect project.'); }
    finally { setBusy(false); }
  }

  async function reindex() {
    if (activeId === null) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ added: number; changed: number; removed: number }>(`/api/projects/${activeId}/index`, { method: 'POST' });
      await loadDashboard(activeId);
      setNotice(`${result.added} added · ${result.changed} changed · ${result.removed} removed`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Indexing failed.'); }
    finally { setBusy(false); }
  }

  async function saveEntry(event: FormEvent) {
    event.preventDefault();
    if (activeId === null) return;
    setSaving(true); setError('');
    try {
      await request(`/api/projects/${activeId}/entries`, { method: 'POST', body: JSON.stringify({ kind, title: entryTitle, body: entryBody }) });
      await loadDashboard(activeId);
      setEntryTitle(''); setEntryBody(''); setDialog(false);
      setNotice('Memory saved to this project');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save memory.'); }
    finally { setSaving(false); }
  }

  async function openFileChange(filePath: string, eventId?: number) {
    if (activeId === null) return;
    const requestId = ++fileDiffRequestId.current;
    setFileChange({
      relative_path: filePath,
      change_type: 'changed',
      before_content: '',
      after_content: '',
    });
    setFileDiffLines([]);
    setFileDiffLoading(true);
    setFileDiffError('');
    setFileDiffCopyError('');
    const query = new URLSearchParams({ path: filePath });
    if (eventId !== undefined) query.set('eventId', String(eventId));
    try {
      const change = await request<FileChange>(`/api/projects/${activeId}/file-change?${query.toString()}`);
      if (requestId !== fileDiffRequestId.current) return;
      setFileChange(change);
      setFileDiffLines(buildDiffLines(change.before_content, change.after_content));
    } catch (reason) {
      if (requestId === fileDiffRequestId.current) {
        setFileDiffError(reason instanceof Error ? reason.message : 'Could not load this file diff.');
      }
    } finally {
      if (requestId === fileDiffRequestId.current) setFileDiffLoading(false);
    }
  }

  function closeFileChange() {
    fileDiffRequestId.current += 1;
    setFileChange(null);
    setFileDiffLoading(false);
  }

  async function copyFileDiff() {
    if (!fileChange) return;
    setFileDiffCopyError('');
    const content = [
      `--- ${fileChange.relative_path}`,
      `+++ ${fileChange.relative_path}`,
      ...fileDiffLines.map(line => `${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '} ${line.text}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(content);
      setNotice('File diff copied to clipboard');
    } catch (reason) {
      setFileDiffCopyError(reason instanceof Error ? `Could not copy the diff: ${reason.message}` : 'Could not copy the diff to the clipboard.');
    }
  }

  async function exportContext() {
    if (activeId === null) return;
    try {
      const response = await fetch(`/api/projects/${activeId}/export`);
      if (!response.ok) throw new Error('Export could not be prepared.');
      const content = await response.text();
      const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${dashboard?.project.name ?? 'project'}-context.md`; link.click();
      URL.revokeObjectURL(url);
      setNotice('Context exported as Markdown');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Export failed.'); }
  }

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const activeProject = dashboard?.project;
  const shownResults = search.trim().length >= 2;

  return (
    <div className="app-shell">
      <aside className="rail">
        <a className="brand" href="#top" aria-label="CONTINUELESS home"><span className="brand-glyph"><span /><span /><span /><span /></span></a>
        <div className="rail-rule" />
        <button className="rail-button selected" aria-label="Project overview" title="Project overview"><Activity size={18} /></button>
        <button className="rail-button" aria-label="Search knowledge" title="Search knowledge" onClick={() => document.querySelector<HTMLInputElement>('.search-input')?.focus()}><Search size={18} /></button>
        <button className="rail-button" aria-label="Project history" title="Project history" onClick={() => document.querySelector('#history')?.scrollIntoView({ behavior: 'smooth' })}><History size={18} /></button>
        <div className="rail-bottom"><span className="local-indicator" title="Data stays on this device" /></div>
      </aside>

      <main className="main-area" id="top">
        <header className="topbar">
          <div className="crumb"><span>WORKSPACE</span><ArrowRight size={13} /><strong>{activeProject?.name ?? 'PROJECT MEMORY'}</strong><ChevronDown size={14} /></div>
          <div className="top-actions"><span className="privacy"><span /> LOCAL ONLY</span><button className="icon-button" title="Export project context" aria-label="Export project context" onClick={exportContext} disabled={!activeId}><ArrowDownToLine size={16} /></button><button className="add-button" onClick={() => { setKind('checkpoint'); setDialog(true); }} disabled={!activeId}><Plus size={15} /> Capture memory</button></div>
        </header>

        <div className="page-content">
          {error && <div className="inline-alert" role="alert"><AlertCircle size={16} />{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}

          {!activeProject ? (
            <section className="welcome-view">
              <div className="welcome-ornament"><span>CL</span><i /><i /><i /></div>
              <p className="eyebrow">A MEMORY THAT MOVES WITH YOU</p>
              <h1>Pick up where<br /><em>you left off.</em></h1>
              <p className="welcome-copy">Keep the decisions, discoveries, and loose ends that make a project yours. Stored on this machine. Ready for whichever agent comes next.</p>
              <form className="connect-form" onSubmit={connectProject}>
                <label htmlFor="folder-path">PROJECT FOLDER PATH</label>
                <div className="path-control"><FolderGit2 size={17} /><input id="folder-path" value={folderPath} onChange={event => setFolderPath(event.target.value)} placeholder="D:\\work\\my-project" /><button type="submit" disabled={busy || !folderPath.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <>Connect <ArrowRight size={15} /></>}</button></div>
                <small>Paste a local folder path. CONTINUELESS reads text files and Git history; it never uploads project data.</small>
              </form>
              {projects.length > 0 && <div className="project-list"><span>RECENT PROJECTS</span>{projects.map(project => <button key={project.id} onClick={() => setActiveId(project.id)}><FolderGit2 size={15} />{project.name}<small>{project.root_path}</small></button>)}</div>}
            </section>
          ) : (
            <>
              <section className="project-heading">
                <div className="heading-main"><div className="project-icon"><Code2 size={21} /></div><div><div className="eyebrow">PROJECT MEMORY <span className="heading-dot">/</span> LOCAL INDEX</div><h1>{activeProject.name}<span className="title-period">.</span></h1><div className="project-path"><span>{activeProject.root_path}</span><button className="path-dropdown" title="Switch project" onClick={() => setActiveId(null)}><ChevronDown size={13} /></button></div></div></div>
                <div className="heading-tools"><button className="subtle-button" onClick={reindex} disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Sync index</button><button className="primary-button" onClick={() => { setKind('checkpoint'); setDialog(true); }}><Plus size={16} /> New memory</button></div>
              </section>

              <section className="status-strip" aria-label="Project status">
                <div className="status-cell"><span className="status-label"><GitBranch size={14} /> BRANCH</span><strong>{dashboard?.git.branch ?? 'No Git repository'}</strong></div>
                <div className="status-cell"><span className="status-label"><GitCommitHorizontal size={14} /> LAST COMMIT</span><strong>{dashboard?.git.lastCommit ? <><code>{dashboard.git.lastCommit.hash}</code> {dashboard.git.lastCommit.subject}</> : 'No commits yet'}</strong></div>
                <div className="status-cell status-changes"><span className="status-label"><FileCode2 size={14} /> WORKTREE</span><strong><span className={dashboard?.git.changedFiles ? 'change-dot' : 'clean-dot'} />{dashboard?.git.changedFiles ?? 0} changed files</strong></div>
                <div className="status-sync"><span /><span>SYNCED {activeProject.indexed_at ? timeAgo(activeProject.indexed_at) : 'JUST NOW'}</span></div>
              </section>

              <section className="metric-row">
                <div className="metric"><span>INDEXED FILES</span><div>{dashboard?.stats.files ?? activeProject.file_count}<small>text files</small></div><FileCode2 size={17} /></div>
                <div className="metric"><span>DECISIONS</span><div>{dashboard?.stats.decisions ?? 0}<small>recorded</small></div><Lightbulb size={17} /></div>
                <div className="metric"><span>OPEN BUGS</span><div>{dashboard?.stats.bugs ?? 0}<small>unresolved</small></div><AlertCircle size={17} /></div>
                <div className="metric"><span>CHECKPOINTS</span><div>{dashboard?.stats.checkpoints ?? 0}<small>captured</small></div><CircleDot size={17} /></div>
              </section>

              <section className="knowledge-section">
                <div className="section-title-row"><div><p className="eyebrow">YOUR PROJECT, REMEMBERED</p><h2>Knowledge base</h2></div><button className="text-button" onClick={exportContext}><ArrowDownToLine size={15} /> Export context</button></div>
                <div className="knowledge-grid">
                  <div className="search-panel">
                    <div className="search-heading"><Search size={16} /><h3>Search project knowledge</h3><span className="search-shortcut">LOCAL INDEX</span></div>
                    <div className="searchbox"><Search size={17} /><input className="search-input" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a file, decision, or task..." /><kbd>⌘ K</kbd></div>
                    {shownResults ? <div className="results-list">{results.length ? results.map(result => <div className="result-item" key={`${result.kind}-${result.id}`}><span className="result-icon">{result.kind === 'file' ? <FileCode2 size={15} /> : <BookOpen size={15} />}</span><div><strong>{result.title}</strong><p>{highlightExcerpt(result.excerpt)}</p><small>{result.kind === 'file' ? result.path : result.kind}</small></div></div>) : <div className="empty-search">No matches yet. Try another term or sync the index.</div>}</div> : <div className="search-hint"><span><span className="hint-key">⌕</span> Search indexed files and saved memories together</span><span>PRIVATE BY DESIGN</span></div>}
                    <div className="search-footer"><span><span className="footer-dot" /> SEARCHABLE FILES</span><span>Markdown · code · project notes</span></div>
                  </div>
                  <div className="capture-panel"><div className="capture-heading"><span className="capture-mark"><Sparkles size={16} /></span><div><h3>Make it stick</h3><p>Capture context before it slips.</p></div></div><div className="capture-options">{kinds.map(item => <button key={item.id} onClick={() => { setKind(item.id); setDialog(true); }}><item.icon size={16} /><span>{item.label}</span><ArrowRight size={14} /></button>)}</div><button className="capture-all" onClick={() => { setKind('checkpoint'); setDialog(true); }}>Capture a memory <Plus size={15} /></button></div>
                </div>
              </section>

              <section className="history-section" id="history">
                <div className="section-title-row history-title"><div><p className="eyebrow">A CLEAR TRAIL FOR THE NEXT SESSION</p><h2>Project history</h2></div><span className="history-count">{dashboard?.events.length ?? 0} RECENT EVENTS</span></div>
                {dashboard?.git.available && <div className="history-working-tree">
                  <div className="history-working-tree-heading"><strong>Updated files</strong><span>{dashboard.git.changedFiles} FILES</span></div>
                  {dashboard.git.workingTreeChanges.length
                    ? <ul>{dashboard.git.workingTreeChanges.map((change, index) => <li className={`history-file-${gitChangeClass(change.status)}`} key={`${change.path}-${index}`}><code>{change.status || 'M'}</code><button onClick={() => void openFileChange(change.path)}>{change.path}</button></li>)}</ul>
                    : <p>Working tree is clean.</p>}
                </div>}
                <div className="history-list">{dashboard?.events.length ? dashboard.events.map((event, index) => {
                  const entry = dashboard.entries.find(item => item.title === event.summary && item.created_at === event.created_at);
                  const type = entry?.kind ?? event.kind;
                  const TypeIcon = kinds.find(item => item.id === type)?.icon ?? (type === 'index' ? RefreshCw : type === 'project' ? FolderGit2 : History);
                  return <article className="history-item" key={event.id}><div className={`history-icon history-${type}`}><TypeIcon size={15} /></div><div className="history-content"><div className="history-meta"><strong>{event.summary}</strong><span className="history-type">{type.replace('-', ' ')}</span></div><div className="history-details">{renderHistoryDetails(event.details, (filePath, fileEventId) => void openFileChange(filePath, fileEventId), event.id)}</div></div><time>{timeAgo(event.created_at)}</time>{index === 0 && <span className="latest-label">LATEST</span>}</article>;
                }) : <div className="history-empty"><Clock3 size={19} /><div><strong>The story starts here.</strong><span>Sync your project or save the first decision to begin a useful history.</span></div><button onClick={() => { setKind('decision'); setDialog(true); }}>Add a decision <ArrowRight size={14} /></button></div>}</div>
              </section>
              <footer className="page-footer"><span>CONTINUELESS <span>·</span> PORTABLE PROJECT MEMORY</span><span><span className="footer-dot" /> ALL DATA STORED LOCALLY</span></footer>
            </>
          )}
        </div>
      </main>

      {fileChange && <div className="modal-backdrop diff-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeFileChange(); }}>
        <section className="diff-dialog" role="dialog" aria-modal="true" aria-labelledby="diff-title">
          <div className="diff-dialog-header">
            <div><p className="eyebrow">FILE CHANGE · {fileChange.change_type.toUpperCase()}</p><h2 id="diff-title">{fileChange.relative_path}</h2></div>
            <div className="diff-dialog-actions"><button type="button" className="subtle-button" onClick={() => void copyFileDiff()} disabled={fileDiffLoading || Boolean(fileDiffError)}><Copy size={14} /> Copy diff</button><button type="button" className="dialog-close" onClick={closeFileChange} aria-label="Close diff"><X size={18} /></button></div>
          </div>
          {fileDiffError
            ? <div className="diff-message diff-error" role="alert">{fileDiffError}</div>
            : fileDiffLoading
              ? <div className="diff-message">Loading file changes…</div>
              : fileDiffLines.length
                ? <><div className="diff-code" role="region" aria-label={`Changes in ${fileChange.relative_path}`}>{fileDiffLines.map((line, index) => <div className={`diff-line diff-${line.type}`} key={`${line.type}-${index}`}><span className="diff-line-number">{line.oldLine ?? ''}</span><span className="diff-line-number">{line.newLine ?? ''}</span><span className="diff-line-marker">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</span><code>{line.text || ' '}</code></div>)}</div>{fileDiffCopyError && <div className="diff-message diff-error" role="alert">{fileDiffCopyError}</div>}</>
                : <div className="diff-message">This file has no text lines to display.</div>}
        </section>
      </div>}

      {dialog && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(false); }}><form className="memory-dialog" onSubmit={saveEntry}><div className="dialog-top"><div><p className="eyebrow">ADD TO PROJECT MEMORY</p><h2>Save what matters<span>.</span></h2></div><button type="button" className="dialog-close" onClick={() => setDialog(false)} aria-label="Close"><X size={18} /></button></div><label className="field-label">MEMORY TYPE</label><div className="kind-picker">{kinds.map(item => <button type="button" key={item.id} className={kind === item.id ? 'kind-active' : ''} onClick={() => setKind(item.id)}><item.icon size={15} />{item.label}</button>)}</div><label className="field-label" htmlFor="memory-title">TITLE</label><input id="memory-title" className="dialog-input" autoFocus value={entryTitle} onChange={event => setEntryTitle(event.target.value)} placeholder={kind === 'decision' ? 'Why are we choosing this?' : 'A short, useful headline'} required maxLength={160} /><label className="field-label" htmlFor="memory-body">DETAILS</label><textarea id="memory-body" className="dialog-input dialog-textarea" value={entryBody} onChange={event => setEntryBody(event.target.value)} placeholder="Add enough context that future-you (or another agent) can pick up the thread..." required rows={5} /><div className="dialog-footer"><span><span className="footer-dot" /> SAVED ON THIS DEVICE</span><button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save memory</button></div></form></div>}

      {notice && <div className="toast"><CheckCircle2 size={16} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14} /></button></div>}
      {activeId === null && projects.length > 0 && <button className="floating-project" onClick={() => setActiveId(projects[0].id)}><FilePlus2 size={16} /> Open recent project</button>}
    </div>
  );
}

export default App;