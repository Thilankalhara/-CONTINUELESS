import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const app = express();
const skippedDirectories = new Set([
  '.git', '.continueless', '.npm-cache', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  'target', 'out', 'bin', 'obj', 'release',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);
const textExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.ini',
  '.java', '.js', '.jsx', '.json', '.md', '.mjs', '.php', '.py', '.rb',
  '.rs', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml', '.zsh', '.env', '.gitignore', '.dockerignore',
]);
const maxIndexedBytes = 16 * 1024 * 1024;
const maxDiffBytes = 16 * 1024 * 1024;

function isGeneratedOutputPath(relativePath: string) {
  return relativePath.split(/[\\/]/).some(segment => segment === 'release' || segment.startsWith('release-'));
}

const port = Number(process.env.PORT ?? 4175);
const dataDir = path.resolve(process.env.CONTINUELESS_DATA_DIR ?? '.continueless');
mkdirSync(dataDir, { recursive: true });
const database = new Database(path.join(dataDir, 'memory.sqlite'));

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
  CREATE TABLE IF NOT EXISTS file_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    change_type TEXT NOT NULL CHECK(change_type IN ('added','changed','removed')),
    before_content TEXT NOT NULL,
    after_content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS history_backups (
    project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS file_changes_project_path ON file_changes(project_id, relative_path, id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    project_id UNINDEXED, record_type UNINDEXED, record_id UNINDEXED,
    title, body, path UNINDEXED
  );
`);

app.use(express.json({ limit: '1mb' }));

type Project = { id: number; name: string; root_path: string; created_at: string; indexed_at: string | null };
type EntryKind = 'decision' | 'checkpoint' | 'bug' | 'work' | 'failed';

function addEvent(projectId: number, kind: string, summary: string, details = '') {
  return Number(database.prepare('INSERT INTO events(project_id, kind, summary, details) VALUES (?, ?, ?, ?)')
    .run(projectId, kind, summary, details).lastInsertRowid);
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
    const [{ stdout: branch }, { stdout: status }, { stdout: log }, { stdout: history }] = await Promise.all([
      execFileAsync('git', ['-C', root, 'branch', '--show-current'], { windowsHide: true }),
      execFileAsync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], { windowsHide: true }),
      execFileAsync('git', ['-C', root, 'log', '-1', '--format=%h|%s|%cr'], { windowsHide: true }),
      execFileAsync('git', ['-C', root, 'log', '-20', '--date=short', '--format=%h%x09%ad%x09%s'], { windowsHide: true }),
    ]);
    const workingTreeChanges = status.split(/\r?\n/).filter(Boolean)
      .map(line => ({ line, path: line.slice(3) }))
      .filter(change => !isGeneratedOutputPath(change.path))
      .map(change => change.line);
    const lastCommit = log.trim().split('|');
    return {
      available: true,
      branch: branch.trim() || 'detached HEAD',
      changedFiles: workingTreeChanges.length,
      workingTreeChanges: workingTreeChanges.map(line => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3),
      })),
      lastCommit: lastCommit.length === 3 ? { hash: lastCommit[0], subject: lastCommit[1], age: lastCommit[2] } : null,
      recentCommits: history.trim().split(/\r?\n/).filter(Boolean).map(line => {
        const [hash, date, ...subject] = line.split('\t');
        return { hash, date, subject: subject.join('\t') };
      }),
    };
  } catch {
    return { available: false, branch: null, changedFiles: 0, workingTreeChanges: [], lastCommit: null, recentCommits: [] };
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
        if (!skippedDirectories.has(child.name) && !child.name.startsWith('release-')) await visit(absolute);
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
  const addedPaths: string[] = [];
  const changedPaths: string[] = [];
  const fileChanges: Array<{ path: string; changeType: 'added' | 'changed' | 'removed'; before: string; after: string }> = [];
  for (const absolute of candidates) {
    try {
      const info = await stat(absolute);
      if (info.size > maxIndexedBytes) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) continue;
      const relative = path.relative(project.root_path, absolute).split(path.sep).join('/');
      const existing = database.prepare('SELECT hash, content FROM files WHERE project_id = ? AND relative_path = ?').get(project.id, relative) as { hash: string; content: string } | undefined;
      const content = buffer.toString('utf8');
      const hash = createHash('sha256').update(buffer).digest('hex');
      seen.add(relative);
      if (!existing || existing.hash !== hash) {
        upsert.run(project.id, relative, content, hash, info.size, info.mtime.toISOString());
        if (existing) {
          changed += 1;
          changedPaths.push(relative);
          fileChanges.push({ path: relative, changeType: 'changed', before: existing.content, after: content });
        } else {
          added += 1;
          addedPaths.push(relative);
          fileChanges.push({ path: relative, changeType: 'added', before: '', after: content });
        }
      }
    } catch { /* Files can disappear while indexing; the next scan reconciles them. */ }
  }
  const oldPaths = database.prepare('SELECT relative_path, content FROM files WHERE project_id = ?').all(project.id) as Array<{ relative_path: string; content: string }>;
  const generatedFiles = oldPaths.filter(file => isGeneratedOutputPath(file.relative_path));
  const removeGenerated = database.prepare('DELETE FROM files WHERE project_id = ? AND relative_path = ?');
  const removeGeneratedTransaction = database.transaction(() => generatedFiles.forEach(file => removeGenerated.run(project.id, file.relative_path)));
  removeGeneratedTransaction();
  const removed = oldPaths.filter(file => !seen.has(file.relative_path) && !isGeneratedOutputPath(file.relative_path));
  for (const file of removed) fileChanges.push({ path: file.relative_path, changeType: 'removed', before: file.content, after: '' });
  const remove = database.prepare('DELETE FROM files WHERE project_id = ? AND relative_path = ?');
  const removeTransaction = database.transaction(() => removed.forEach(file => remove.run(project.id, file.relative_path)));
  removeTransaction();
  const summary = `${added} added, ${changed} changed, ${removed.length} removed`;
  database.prepare("UPDATE projects SET indexed_at = datetime('now') WHERE id = ?").run(project.id);
  if (added || changed || removed.length) {
    const details = [
      summary,
      ...(addedPaths.length ? ['Added:', ...addedPaths.map(file => `- ${file}`)] : []),
      ...(changedPaths.length ? ['Changed:', ...changedPaths.map(file => `- ${file}`)] : []),
      ...(removed.length ? ['Removed:', ...removed.map(file => `- ${file.relative_path}`)] : []),
    ].join('\n');
    const saveChanges = database.prepare(`
      INSERT INTO file_changes(project_id, event_id, relative_path, change_type, before_content, after_content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const recordChangesTransaction = database.transaction(() => {
      const eventId = addEvent(project.id, 'index', 'Project files updated', details);
      for (const file of fileChanges) {
        saveChanges.run(project.id, eventId, file.path, file.changeType, file.before, file.after);
      }
    });
    recordChangesTransaction();
  }
  refreshProjectSearch(project.id);
  return { scanned: candidates.length, added, changed, removed: removed.length, indexedAt: new Date().toISOString() };
}

function asProject(id: number): Project | undefined {
  return database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

function getReadmeContext(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const cleanLine = (line: string) => line
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
  const isUsefulLine = (line: string) => {
    const trimmed = cleanLine(line);
    return trimmed && !trimmed.startsWith('![') && trimmed !== '---';
  };
  const firstSectionIndex = lines.findIndex(line => /^##\s+/.test(line));
  const intro = lines
    .slice(0, firstSectionIndex < 0 ? lines.length : firstSectionIndex)
    .filter(isUsefulLine)
    .filter(line => !/^#\s+/.test(line))
    .map(cleanLine);
  const sections: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{2,3})\s+(.+)$/);
    if (!heading || !/overview|about|what (?:is|this)|how .*?(?:works?|use)|architecture|core capabilities|features|workflow|day.to.day|project structure/i.test(heading[2])) continue;
    const depth = heading[1].length;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextHeading = lines[next].match(/^(#{1,6})\s+/);
      if (nextHeading && nextHeading[1].length <= depth) break;
      if (isUsefulLine(lines[next])) body.push(cleanLine(lines[next]));
    }
    if (body.length) sections.push(`### ${cleanLine(heading[2])}`, ...body);
  }
  return [...intro, ...sections].slice(0, 120);
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
    Promise.resolve(database.prepare(`SELECT e.* FROM events e
      WHERE e.project_id = ? AND (
        e.kind != 'index' OR EXISTS (
          SELECT 1 FROM file_changes fc
          WHERE fc.project_id = e.project_id AND fc.event_id = e.id
            AND fc.relative_path NOT LIKE 'release/%'
            AND fc.relative_path NOT LIKE '%/release/%'
            AND fc.relative_path NOT LIKE 'release-%'
            AND fc.relative_path NOT LIKE '%/release-%'
        )
      )
      ORDER BY e.id DESC LIMIT 24`).all(project.id) as Array<{ id: number; project_id: number; kind: string; summary: string; details: string; created_at: string }>),
    Promise.resolve(database.prepare('SELECT * FROM entries WHERE project_id = ? ORDER BY id DESC LIMIT 30').all(project.id)),
    Promise.resolve(database.prepare(`SELECT
      (SELECT COUNT(*) FROM files WHERE project_id = ?) AS files,
      (SELECT COUNT(*) FROM entries WHERE project_id = ? AND kind = 'decision') AS decisions,
      (SELECT COUNT(*) FROM entries WHERE project_id = ? AND kind = 'bug') AS bugs,
      (SELECT COUNT(*) FROM entries WHERE project_id = ? AND kind = 'checkpoint') AS checkpoints`,).get(project.id, project.id, project.id, project.id)),
  ]);
  const visibleEvents = events.flatMap(event => {
    if (event.kind !== 'index') return [event];
    const changes = database.prepare('SELECT relative_path, change_type FROM file_changes WHERE project_id = ? AND event_id = ?')
      .all(project.id, event.id) as Array<{ relative_path: string; change_type: 'added' | 'changed' | 'removed' }>;
    const visibleChanges = changes.filter(change => !isGeneratedOutputPath(change.relative_path));
    if (!visibleChanges.length) return [];
    const counts = { added: 0, changed: 0, removed: 0 };
    for (const change of visibleChanges) counts[change.change_type] += 1;
    const details = [
      `${counts.added} added, ${counts.changed} changed, ${counts.removed} removed`,
      ...(['added', 'changed', 'removed'] as const).flatMap(changeType => {
        const paths = visibleChanges.filter(change => change.change_type === changeType).map(change => change.relative_path);
        return paths.length ? [`${changeType[0].toUpperCase()}${changeType.slice(1)}:`, ...paths.map(file => `- ${file}`)] : [];
      }),
    ].join('\n');
    return [{ ...event, summary: 'Project files updated', details }];
  }).slice(0, 24);
  const historyBackupAvailable = Boolean(database.prepare('SELECT 1 FROM history_backups WHERE project_id = ?').get(project.id));
  response.json({ project, git, events: visibleEvents, entries, stats, historyBackupAvailable });
});

app.delete('/api/projects/:id/history', (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  const events = database.prepare('SELECT id, kind, summary, details, created_at FROM events WHERE project_id = ?').all(project.id);
  const changes = database.prepare('SELECT event_id, relative_path, change_type, before_content, after_content FROM file_changes WHERE project_id = ?').all(project.id);
  const clearHistory = database.transaction(() => {
    if (events.length) {
      database.prepare(`INSERT INTO history_backups(project_id, snapshot) VALUES (?, ?)
        ON CONFLICT(project_id) DO UPDATE SET snapshot = excluded.snapshot, created_at = CURRENT_TIMESTAMP`)
        .run(project.id, JSON.stringify({ events, changes }));
    }
    return database.prepare('DELETE FROM events WHERE project_id = ?').run(project.id).changes;
  });
  response.json({ cleared: clearHistory(), canRestore: events.length > 0 });
});

app.post('/api/projects/:id/history/restore', (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  const backup = database.prepare('SELECT snapshot FROM history_backups WHERE project_id = ?').get(project.id) as { snapshot: string } | undefined;
  if (!backup) return response.status(404).json({ error: 'There is no cleared history to restore.' });
  try {
    const snapshot = JSON.parse(backup.snapshot) as {
      events: Array<{ id: number; kind: string; summary: string; details: string; created_at: string }>;
      changes: Array<{ event_id: number; relative_path: string; change_type: 'added' | 'changed' | 'removed'; before_content: string; after_content: string }>;
    };
    const restoreHistory = database.transaction(() => {
      const eventIds = new Map<number, number>();
      const insertWithId = database.prepare('INSERT INTO events(id, project_id, kind, summary, details, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      const insertNew = database.prepare('INSERT INTO events(project_id, kind, summary, details, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const event of snapshot.events) {
        if (!database.prepare('SELECT 1 FROM events WHERE id = ?').get(event.id)) {
          insertWithId.run(event.id, project.id, event.kind, event.summary, event.details, event.created_at);
          eventIds.set(event.id, event.id);
        } else {
          const result = insertNew.run(project.id, event.kind, event.summary, event.details, event.created_at);
          eventIds.set(event.id, Number(result.lastInsertRowid));
        }
      }
      const insertChange = database.prepare(`INSERT INTO file_changes(project_id, event_id, relative_path, change_type, before_content, after_content)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const change of snapshot.changes) {
        const eventId = eventIds.get(change.event_id);
        if (eventId !== undefined) {
          insertChange.run(project.id, eventId, change.relative_path, change.change_type, change.before_content, change.after_content);
        }
      }
      database.prepare('DELETE FROM history_backups WHERE project_id = ?').run(project.id);
      return snapshot.events.length;
    });
    response.json({ restored: restoreHistory() });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? `Could not restore project history: ${error.message}` : 'Could not restore project history.' });
  }
});

app.get('/api/projects/:id/file-change', async (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  const relativePath = String(request.query.path ?? '');
  if (!relativePath) return response.status(400).json({ error: 'Choose a project file.' });
  if (isGeneratedOutputPath(relativePath)) {
    return response.status(415).json({ error: 'Generated release files are excluded from project history.' });
  }
  const requestedEventId = request.query.eventId;
  const eventId = Number(requestedEventId);
  if (requestedEventId !== undefined && (!Number.isSafeInteger(eventId) || eventId <= 0)) {
    return response.status(400).json({ error: 'Choose a valid project history event.' });
  }
  let fileChange = Number.isSafeInteger(eventId) && eventId > 0
    ? database.prepare('SELECT relative_path, change_type, before_content, after_content FROM file_changes WHERE project_id = ? AND event_id = ? AND relative_path = ?').get(project.id, eventId, relativePath)
    : undefined;
  if (requestedEventId === undefined) {
    const git = await getGitSummary(project.root_path);
    const workingTreeChange = git.workingTreeChanges.find(change => change.path === relativePath);
    if (workingTreeChange) {
      const isAdded = workingTreeChange.status === '??' || workingTreeChange.status.includes('A');
      const isRemoved = workingTreeChange.status.includes('D');
      let afterContent = '';
      if (!isRemoved) {
        const absolutePath = path.resolve(project.root_path, relativePath);
        const resolvedPath = path.relative(project.root_path, absolutePath);
        if (resolvedPath === '..' || resolvedPath.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedPath)) {
          return response.status(400).json({ error: 'The selected file is outside the project folder.' });
        }
        try {
          const actualPath = await realpath(absolutePath);
          const actualRelativePath = path.relative(project.root_path, actualPath);
          if (actualRelativePath === '..' || actualRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelativePath)) {
            return response.status(400).json({ error: 'The selected file is outside the project folder.' });
          }
          const info = await stat(actualPath);
          if (!info.isFile() || info.size > maxDiffBytes) {
            return response.status(413).json({ error: 'This file is too large to show as a text diff.' });
          }
          const content = await readFile(actualPath);
          if (content.includes(0)) return response.status(415).json({ error: 'Binary files cannot be shown as text diffs.' });
          afterContent = content.toString('utf8');
        } catch (error) {
          return response.status(404).json({ error: error instanceof Error ? `Could not read ${relativePath}: ${error.message}` : 'Could not read the selected file.' });
        }
      }
      let beforeContent = '';
      if (!isAdded) {
        try {
          const result = await execFileAsync('git', ['-C', project.root_path, '--literal-pathspecs', 'show', `HEAD:${relativePath}`], { windowsHide: true, maxBuffer: maxDiffBytes * 2 });
          beforeContent = result.stdout;
        } catch (error) {
          return response.status(500).json({ error: error instanceof Error ? `Could not read the Git version of ${relativePath}: ${error.message}` : 'Could not read the Git version of this file.' });
        }
      }
      return response.json({
        relative_path: relativePath,
        change_type: isAdded ? 'added' : isRemoved ? 'removed' : 'changed',
        before_content: beforeContent,
        after_content: afterContent,
      });
    }
    fileChange = database.prepare('SELECT relative_path, change_type, before_content, after_content FROM file_changes WHERE project_id = ? AND relative_path = ? ORDER BY id DESC LIMIT 1').get(project.id, relativePath);
  }
  if (!fileChange) return response.status(404).json({ error: 'No saved text diff is available for this file yet. Sync the project and try again.' });
  return response.json(fileChange);
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

app.get('/api/projects/:id/export', async (request, response) => {
  const project = asProject(Number(request.params.id));
  if (!project) return response.status(404).json({ error: 'Project not found.' });
  let indexedAt: string;
  try {
    ({ indexedAt } = await indexProject(project));
  } catch (error) {
    return response.status(500).json({ error: error instanceof Error ? error.message : 'Could not update the project index for export.' });
  }
  const git = await getGitSummary(project.root_path);
  const entries = database.prepare('SELECT kind, title, body, created_at FROM entries WHERE project_id = ? ORDER BY id DESC').all(project.id) as Array<{ kind: string; title: string; body: string; created_at: string }>;
  const files = database.prepare('SELECT relative_path, content FROM files WHERE project_id = ? ORDER BY relative_path').all(project.id) as Array<{ relative_path: string; content: string }>;
  const sections: Record<string, string> = { decision: 'Architectural decisions', checkpoint: 'Task checkpoints', bug: 'Unresolved bugs', work: 'Completed work', failed: 'Failed tasks' };
  const readme = files.find(file => /^readme\.md$/i.test(file.relative_path))?.content;
  const readmeContext = readme ? getReadmeContext(readme) : [];
  const packageFile = files.find(file => /^package\.json$/i.test(file.relative_path));
  const latestCheckpoint = entries.find(entry => entry.kind === 'checkpoint');
  const openBugs = entries.filter(entry => entry.kind === 'bug');
  const completedWork = entries.filter(entry => entry.kind === 'work');
  const lines = [
    `# ${project.name} project handoff`,
    '',
    `Project path: ${project.root_path}`,
    `Last indexed: ${indexedAt}`,
    '',
    '## What this project is and how it works',
    ...(readmeContext.length ? readmeContext : ['No README overview or project workflow documentation was found.']),
    '',
    '## Current status',
    ...(git.available ? [
      `- Git branch: ${git.branch}`,
      `- Uncommitted files: ${git.changedFiles}`,
      ...(git.lastCommit ? [`- Latest commit: ${git.lastCommit.hash} ${git.lastCommit.subject} (${git.lastCommit.age})`] : []),
    ] : ['- Git history is unavailable for this folder.']),
    `- Indexed text files: ${files.length}`,
    `- Saved memories: ${entries.length}`,
  ];
  if (packageFile) {
    try {
      const manifest = JSON.parse(packageFile.content) as {
        name?: string;
        description?: string;
        engines?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      const scripts = manifest.scripts ?? {};
      lines.push('', '## Technology and common commands');
      if (manifest.name) lines.push(`- Package: ${manifest.name}`);
      if (manifest.description) lines.push(`- Description: ${manifest.description}`);
      if (manifest.engines && Object.keys(manifest.engines).length) {
        lines.push(`- Runtime requirements: ${Object.entries(manifest.engines).map(([name, version]) => `${name} ${version}`).join(', ')}`);
      }
      const dependencies = Object.keys(manifest.dependencies ?? {});
      const devDependencies = Object.keys(manifest.devDependencies ?? {});
      if (dependencies.length) lines.push(`- Main dependencies: ${dependencies.join(', ')}`);
      if (devDependencies.length) lines.push(`- Development tools: ${devDependencies.join(', ')}`);
      for (const name of ['dev', 'start', 'build', 'test', 'check']) {
        if (scripts[name]) lines.push(`- \`npm run ${name}\`: ${scripts[name]}`);
      }
    } catch (error) {
      lines.push('', '## Project manifest', '', `Could not summarize package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  lines.push(
    '',
    '## Progress and next steps',
    ...(latestCheckpoint
      ? [`Latest checkpoint: **${latestCheckpoint.title}**`, '', latestCheckpoint.body]
      : ['No checkpoint has been saved yet. Add one with completed work and next steps to guide the next session.']),
  );
  if (completedWork.length) {
    lines.push('', '### Completed work notes');
    for (const entry of completedWork) lines.push(`- **${entry.title}:** ${entry.body}`);
  }
  if (openBugs.length) {
    lines.push('', '### Open bugs');
    for (const entry of openBugs) lines.push(`- **${entry.title}:** ${entry.body}`);
  }
  if (git.available) {
    lines.push('', '## Recent Git commits');
    if (git.recentCommits.length) {
      for (const commit of git.recentCommits) lines.push(`- ${commit.date} ${commit.hash} ${commit.subject}`);
    } else {
      lines.push('- No commits yet.');
    }
    lines.push('', '## Current changed files');
    if (git.workingTreeChanges.length) {
      for (const change of git.workingTreeChanges) lines.push(`- [${change.status || 'modified'}] ${change.path}`);
    } else {
      lines.push('- Working tree is clean.');
    }
  } else {
    lines.push('', '## Current changed files', '', 'Git history is unavailable for this folder.');
  }
  lines.push('', '## Indexed files', ...files.map(file => `- ${file.relative_path}`));
  for (const [kind, heading] of Object.entries(sections)) {
    const selected = entries.filter(entry => entry.kind === kind);
    if (!selected.length) continue;
    lines.push('', `## ${heading}`);
    for (const entry of selected) lines.push('', `### ${entry.title}`, `_${new Date(`${entry.created_at.replace(' ', 'T')}Z`).toLocaleString()}_`, '', entry.body);
  }
  lines.push('', '---', 'Generated locally by CONTINUELESS.');
  response.type('text/markdown').send(lines.join('\n'));
});

type ServerOptions = { port?: number; webRoot?: string };

export async function startServer(options: ServerOptions = {}): Promise<Server> {
  const selectedPort = options.port ?? port;
  const listener = await new Promise<Server>((resolve, reject) => {
    const server = app.listen(selectedPort, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });

  if (options.webRoot) {
    const webRoot = path.resolve(options.webRoot);
    app.use(express.static(webRoot));
    app.use((request, response, next) => {
      if (request.method !== 'GET') return next();
      if (request.path === '/api' || request.path.startsWith('/api/')) return next();
      return response.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  listener.once('close', () => database.close());
  const address = listener.address();
  const listeningPort = typeof address === 'object' && address ? address.port : selectedPort;
  console.log(`CONTINUELESS API listening at http://127.0.0.1:${listeningPort}`);
  console.log(`Local memory database: ${path.join(dataDir, 'memory.sqlite')}`);
  return listener;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer().catch(error => {
    console.error('Could not start the CONTINUELESS API:', error);
    process.exitCode = 1;
  });
}