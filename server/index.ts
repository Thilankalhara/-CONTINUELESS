import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.PORT ?? 4175);
const dataDir = path.resolve(process.env.CONTINUELESS_DATA_DIR ?? '.continueless');
mkdirSync(dataDir, { recursive: true });
const database = new Database(path.join(dataDir, 'memory.sqlite'));
const skippedDirectories = new Set([
  '.git', '.continueless', '.npm-cache', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);
const textExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.ini',
  '.java', '.js', '.jsx', '.json', '.md', '.mjs', '.php', '.py', '.rb',
  '.rs', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml', '.zsh', '.env', '.gitignore', '.dockerignore',
]);
const maxIndexedBytes = 512 * 1024;

database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    indexed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    UNIQUE(project_id, relative_path)
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('decision','checkpoint','bug','work','failed')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    project_id UNINDEXED, record_type UNINDEXED, record_id UNINDEXED,
    title, body, path UNINDEXED
  );
`);

app.use(express.json({ limit: '1mb' }));

type Project = { id: number; name: string; root_path: string; created_at: string; indexed_at: string | null };
type EntryKind = 'decision' | 'checkpoint' | 'bug' | 'work' | 'failed';

function addEvent(projectId: number, kind: string, summary: string, details = '') {
  database.prepare('INSERT INTO events(project_id, kind, summary, details) VALUES (?, ?, ?, ?)')
    .run(projectId, kind, summary, details);
}

function refreshProjectSearch(projectId: number) {
  database.prepare('DELETE FROM knowledge_fts WHERE project_id = ?').run(projectId);
  const entries = database.prepare('SELECT id, title, body, kind FROM entries WHERE project_id = ?').all(projectId) as Array<{ id: number; title: string; body: string; kind: string }>;
  const files = database.prepare('SELECT id, relative_path, content FROM files WHERE project_id = ?').all(projectId) as Array<{ id: number; relative_path: string; content: string }>;
  const insert = database.prepare('INSERT INTO knowledge_fts(project_id, record_type, record_id, title, body, path) VALUES (?, ?, ?, ?, ?, ?)');
  const update = database.transaction(() => {
    for (const entry of entries) insert.run(projectId, entry.kind, entry.id, entry.title, entry.body, '');
    for (const file of files) insert.run(projectId, 'file', file.id, file.relative_path, file.content, file.relative_path);
  });
  update();
}

async function getGitSummary(root: string) {
  try {
    const [{ stdout: branch }, { stdout: status }, { stdout: log }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'branch', '--show-current'], { windowsHide: true }),
      execFileAsync('git', ['-C', root, 'status', '--porcelain'], { windowsHide: true }),
      execFileAsync('git', ['-C', root, 'log', '-1', '--format=%h|%s|%cr'], { windowsHide: true }),
    ]);
    const lastCommit = log.trim().split('|');
    return {
      available: true,
      branch: branch.trim() || 'detached HEAD',
      changedFiles: status.trim() ? status.trim().split(/\r?\n/).length : 0,
      lastCommit: lastCommit.length === 3 ? { hash: lastCommit[0], subject: lastCommit[1], age: lastCommit[2] } : null,
    };
  } catch {
    return { available: false, branch: null, changedFiles: 0, lastCommit: null };
  }
}

async function listSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string) => {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        if (!skippedDirectories.has(child.name)) await visit(absolute);
      } else if (child.isFile() && (textExtensions.has(path.extname(child.name).toLowerCase()) || child.name.startsWith('.'))) {
        found.push(absolute);
      }
    }
  };
  await visit(root);
  return found;
}

async function indexProject(project: Project) {
  const candidates = await listSourceFiles(project.root_path);
  const seen = new Set<string>();
  const upsert = database.prepare(`
    INSERT INTO files(project_id, relative_path, content, hash, size, modified_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
      content = excluded.content, hash = excluded.hash, size = excluded.size, modified_at = excluded.modified_at
    WHERE files.hash != excluded.hash
  `);
  let added = 0;
  let changed = 0;
  for (const absolute of candidates) {
    try {
      const info = await stat(absolute);
      if (info.size > maxIndexedBytes) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) continue;
      const relative = path.relative(project.root_path, absolute).split(path.sep).join('/');
      const existing = database.prepare('SELECT hash FROM files WHERE project_id = ? AND relative_path = ?').get(project.id, relative) as { hash: string } | undefined;
      const content = buffer.toString('utf8');
      const hash = createHash('sha256').update(buffer).digest('hex');
      seen.add(relative);
      if (!existing || existing.hash !== hash) {
        upsert.run(project.id, relative, content, hash, info.size, info.mtime.toISOString());
        if (existing) changed += 1;
        else added += 1;
      }
    } catch { /* Files can disappear while indexing; the next scan reconciles them. */ }
  }
  const oldPaths = database.prepare('SELECT relative_path FROM files WHERE project_id = ?').all(project.id) as Array<{ relative_path: string }>;
  const removed = oldPaths.filter(file => !seen.has(file.relative_path));
  const remove = database.prepare('DELETE FROM files WHERE project_id = ? AND relative_path = ?');
  const removeTransaction = database.transaction(() => removed.forEach(file => remove.run(project.id, file.relative_path)));
  removeTransaction();
  const summary = `${added} added, ${changed} changed, ${removed.length} removed`;
  database.prepare("UPDATE projects SET indexed_at = datetime('now') WHERE id = ?").run(project.id);
  if (added || changed || removed.length) addEvent(project.id, 'index', 'Project index updated', summary);
  refreshProjectSearch(project.id);
  return { scanned: candidates.length, added, changed, removed: removed.length, indexedAt: new Date().toISOString() };
}

function asProject(id: number): Project | undefined {
  return database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

app.get('/api/health', (_request, response) => response.json({ ok: true }));

app.get('/api/projects', (_request, response) => {
  const projects = database.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS file_count,
      (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id) AS entry_count
    FROM projects p ORDER BY p.created_at DESC
  `).all();
  response.json(projects);
});

app.post('/api/projects', async (request, response) => {
  const requestedPath = String(request.body?.path ?? '').trim();
  if (!requestedPath) return response.status(400).json({ error: 'Enter a project folder path.' });
  try {
    const root = await realpath(requestedPath);
    if (!(await stat(root)).isDirectory()) return response.status(400).json({ error: 'That path is not a folder.' });
    const name = path.basename(root) || root;
    const result = database.prepare('INSERT OR IGNORE INTO projects(name, root_path) VALUES (?, ?)').run(name, root);
    const project = database.prepare('SELECT * FROM projects WHERE root_path = ?').get(root) as Project;
    if (result.changes) addEvent(project.id, 'project', 'Project connected', root);
    const indexing = await indexProject(project);
    return response.status(result.changes ? 201 : 200).json({ ...project, indexing });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : 'Could not open that folder.' });
  }
});

app.get('/api/projects/:id/dashboard', async (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  const [git, events, entries, stats] = await Promise.all([
    getGitSummary(project.root_path),
    Promise.resolve(database.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 24').all(project.id)),
    Promise.resolve(database.prepare('SELECT * FROM entries WHERE project_id = ? ORDER BY id DESC LIMIT 30').all(project.id)),
    Promise.resolve(database.prepare(`SELECT
      (SELECT COUNT(*) FROM files WHERE project_id = ?) AS files,
      (SELECT COUNT(*) FROM entries WHERE project_id = ? AND kind = 'decision') AS decisions,
      (SELECT COUNT(*) FROM entries WHERE project_id = ? AND kind = 'bug') AS bugs,
      (SELECT COUNT(*) FROM entries WHERE project_id = ? AND kind = 'checkpoint') AS checkpoints`,).get(project.id, project.id, project.id, project.id)),
  ]);
  response.json({ project, git, events, entries, stats });
});

app.post('/api/projects/:id/index', async (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  try { return response.json(await indexProject(project)); }
  catch (error) { return response.status(500).json({ error: error instanceof Error ? error.message : 'Indexing failed.' }); }
});

app.post('/api/projects/:id/entries', (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  const kind = String(request.body?.kind ?? '') as EntryKind;
  const title = String(request.body?.title ?? '').trim();
  const body = String(request.body?.body ?? '').trim();
  if (!['decision', 'checkpoint', 'bug', 'work', 'failed'].includes(kind)) return response.status(400).json({ error: 'Choose a valid memory type.' });
  if (!title || !body) return response.status(400).json({ error: 'A title and note are both required.' });
  const result = database.prepare('INSERT INTO entries(project_id, kind, title, body) VALUES (?, ?, ?, ?)').run(project.id, kind, title, body);
  const entry = database.prepare('SELECT * FROM entries WHERE id = ?').get(result.lastInsertRowid);
  addEvent(project.id, kind, title, body);
  refreshProjectSearch(project.id);
  return response.status(201).json(entry);
});

app.get('/api/projects/:id/search', (request, response) => {
  const projectId = Number(request.params.id);
  if (!asProject(projectId)) return response.status(404).json({ error: 'Project not found.' });
  const query = String(request.query.q ?? '').trim();
  if (query.length < 2) return response.json({ results: [] });
  const safeQuery = query.replace(/["*:^{}]/g, ' ').trim().split(/\s+/).filter(Boolean).map(term => `"${term}"*`).join(' AND ');
  try {
    const results = database.prepare(`
      SELECT record_type AS kind, record_id AS id, title, snippet(knowledge_fts, 4, '<mark>', '</mark>', '...', 18) AS excerpt, path
      FROM knowledge_fts WHERE knowledge_fts MATCH ? AND project_id = ? LIMIT 30
    `).all(safeQuery, projectId);
    return response.json({ results });
  } catch { return response.json({ results: [] }); }
});

app.get('/api/projects/:id/export', (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  const entries = database.prepare('SELECT kind, title, body, created_at FROM entries WHERE project_id = ? ORDER BY id DESC').all(project.id) as Array<{ kind: string; title: string; body: string; created_at: string }>;
  const files = database.prepare('SELECT relative_path FROM files WHERE project_id = ? ORDER BY relative_path').all(project.id) as Array<{ relative_path: string }>;
  const sections: Record<string, string> = { decision: 'Architectural decisions', checkpoint: 'Task checkpoints', bug: 'Unresolved bugs', work: 'Completed work', failed: 'Failed tasks' };
  const lines = [`# ${project.name} project context`, '', `Project path: ${project.root_path}`, `Last indexed: ${project.indexed_at ?? 'Not yet indexed'}`, '', '## Indexed files', ...files.map(file => `- ${file.relative_path}`)];
  for (const [kind, heading] of Object.entries(sections)) {
    const selected = entries.filter(entry => entry.kind === kind);
    if (!selected.length) continue;
    lines.push('', `## ${heading}`);
    for (const entry of selected) lines.push('', `### ${entry.title}`, `_${new Date(`${entry.created_at.replace(' ', 'T')}Z`).toLocaleString()}_`, '', entry.body);
  }
  lines.push('', '---', 'Generated locally by CONTINUELESS.');
  response.type('text/markdown').send(lines.join('\n'));
});

app.listen(port, '127.0.0.1', () => {
  console.log(`CONTINUELESS API listening at http://127.0.0.1:${port}`);
  console.log(`Local memory database: ${path.join(dataDir, 'memory.sqlite')}`);
});