# CONTINUELESS

<p align="center">
  <strong>Portable memory for AI coding agents.</strong><br />
  Keep your project's architecture, decisions, progress, and next steps—so you can pick up where you left off.
</p>

<p align="center">
  <a href="https://github.com/Thilankalhara/-CONTINUELESS/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-317964.svg"></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white">
</p>

Switching between AI coding assistants can mean losing the project context you have already explained: how the architecture fits together, what has been tried, and what still needs doing. CONTINUELESS is a local application that gives that context a persistent home.

Connect a project folder to index its text files, record decisions and work history, and search files and notes together. When you switch tools or sessions, export the project context as Markdown and provide it to your AI coding assistant.

Your project files, index, and saved memories stay on your machine. CONTINUELESS does not upload them.

## Core capabilities

- **Local project indexing:** Build a searchable index of supported project text files.
- **Git integration:** View the current branch, most recent commit, and working-tree changes.
- **Persistent memory:** Store project indexes, activity, and notes in a local SQLite database.
- **Change detection:** Sync the index manually or let CONTINUELESS refresh it automatically while open.
- **Project history:** Record architectural decisions, task checkpoints, open bugs, completed work, and failed tasks.
- **Searchable knowledge:** Search indexed project files and saved memories together.
- **Portable context:** Export saved memories and an indexed-file list as Markdown for use with AI coding tools.
- **Project dashboard:** Review project status, memory counts, recent history, and search from one place.

## Screenshots

<p align="center">
  <img src="screenshots/dashboard.png" alt="CONTINUELESS project dashboard with project status, indexed file and memory counts, and knowledge search" width="400">
</p>

<p align="center"><em>Project dashboard: see project status and find indexed files and saved memories.</em></p>

<p align="center">
  <img src="screenshots/knowledge-search.png" alt="CONTINUELESS knowledge search showing searchable project context" width="400">
</p>

<p align="center"><em>Search project files and notes together from the local index.</em></p>

## Get started

### 1. Install the prerequisites

- [Node.js](https://nodejs.org/) **20.19 or newer** (Node.js 22 LTS is also supported).
- npm, which is included with Node.js.
- [Git](https://git-scm.com/downloads) is optional, but needed to show Git branch, commit, and working-tree information for a connected project.

### 2. Download the project

Open a terminal and clone this repository:

```bash
git clone https://github.com/Thilankalhara/-CONTINUELESS.git continueless
cd continueless
```

On Windows, you can run these commands in PowerShell too.

### 3. Install dependencies

```bash
npm install
```

### 4. Start CONTINUELESS

```bash
npm run dev
```

When the servers are ready, open **http://127.0.0.1:5173** in your browser. Leave the terminal running while you use the app. Press **Ctrl+C** in that terminal to stop it.

### 5. Connect a project

1. Copy the full path to a project folder on your computer.
2. Paste the path into the **Project folder path** field in CONTINUELESS. For example:
   - Windows: `C:\Users\you\work\my-project`
   - macOS/Linux: `/Users/you/work/my-project`
3. Select **Connect** and wait for the initial index to finish.
4. Search the project, capture a memory, or export its context.

The same folder can be reopened from the recent-project list the next time you run CONTINUELESS.

## How to work with CONTINUELESS

1. **Connect your working project.** Start the app, enter the full path to a project folder, and select **Connect**. CONTINUELESS indexes supported text files locally and, if the folder is a Git repository, reads its branch and recent status.
2. **Capture context as you work.** Select **New memory** or **Capture memory**, choose a type, and write a descriptive title and note. Record decisions with their reasoning, checkpoints with completed and remaining work, bugs with reproduction details, and failed approaches with what you learned.
3. **Find information again.** Search with at least two characters to look across indexed project files and saved memories. Press **Ctrl+K** (or **⌘K** on macOS) to focus search.
4. **Keep the index current.** Choose **Sync index** after making changes. While the app is open, it also checks for project changes automatically.
5. **Bring context to another tool or session.** Select **Export context** to download a Markdown file containing saved memories and the indexed-file list. Open that file or paste its relevant contents into your AI coding assistant when you start working in the project. Export is a manual handoff; CONTINUELESS does not automatically connect to or send context to an AI assistant.

### A simple day-to-day workflow

- At the beginning of a session, search for the latest checkpoint and unresolved bugs.
- During work, capture important decisions and discoveries while they are fresh.
- Before switching assistants or ending a session, save a checkpoint with what changed and the next steps.
- Export context when you need to provide that project history to another tool.

## What is indexed and where data is stored

CONTINUELESS indexes supported text and source files up to **512 KB each**. It skips common generated or dependency folders such as `.git`, `node_modules`, `dist`, and `build`, as well as binary files. It reads the folder you explicitly connect; it does not modify your project files.

The app stores its database in `.continueless/memory.sqlite` in the directory where the app is run. This database contains the project index and the memories you capture. The `.continueless/` directory is ignored by Git in this repository. Keep a copy of this directory if you want to back up your local memory.

All app services bind to `127.0.0.1` by default. No project contents are sent to an external service.

## Developer commands

Run these commands from the repository folder:

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the local API and the Vite development server. |
| `npm run check` | Type-checks the app and server. |
| `npm run build` | Type-checks and builds the frontend into `dist/`. |
| `npm run start` | Starts the local API server. |

The development server is available at `http://127.0.0.1:5173`; the API listens on `http://127.0.0.1:4175`. The Vite development server forwards `/api` requests to the API.

### Optional local settings

The API reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4175` | Port for the local API server. |
| `CONTINUELESS_DATA_DIR` | `.continueless` | Directory for `memory.sqlite`, relative to the app's working directory unless an absolute path is given. |

For example, in PowerShell:

```powershell
$env:CONTINUELESS_DATA_DIR = "D:\local-data\continueless"
npm run dev
```

In macOS or Linux:

```bash
CONTINUELESS_DATA_DIR="$HOME/.local/share/continueless" npm run dev
```

## Troubleshooting

- **The page does not load:** Make sure `npm run dev` is still running, then open `http://127.0.0.1:5173`.
- **A port is already in use:** Stop the other process using that port, or set a different `PORT` for the API. If you change the API port, update the proxy target in `vite.config.ts` to match.
- **A folder will not connect:** Check that the path exists and that your user account can read it. Enter the path to the folder itself, not to a file inside it.
- **Git details are missing:** Install Git and make sure the `git` command is available in your terminal. The rest of the app can be used without a Git repository.
- **A file is missing from search:** Confirm it is a supported text file smaller than 512 KB, is not inside a skipped folder, and run **Sync index**.

## Contributing

Contributions are welcome. To make a change, create a branch, install dependencies with `npm install`, and run `npm run check` and `npm run build` before opening a pull request.

## License

CONTINUELESS is distributed under the [MIT License](LICENSE).