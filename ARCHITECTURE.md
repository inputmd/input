# Architecture

Input is a complex frontend application with state distributed across
many components. The important areas include:

## Workspaces

## File persistence

For installed repos, file state flows through several layers between GitHub
and the UI.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            GitHub                                       │
│                                                                         │
│   Git Data API (GraphQL)              Contents API (REST)               │
│   ─────────────────────               ───────────────────               │
│   applyRepoBatchMutationAtomic        putRepoFile (single-file)         │
│   - batch creates/updates/deletes     - create or update one file       │
│     in one atomic commit              - works on empty repos            │
│   - requires existing default branch  - returns { sha, path }           │
│                                                                         │
│   getRepoTree ──────────────────┐  getRepoContents ───────┐             │
│   (full tree listing)           │  (single file body)     │             │
│                                 │                         │             │
│   getRepoTarball ─────────┐     │                         │             │
│   (archive of all files)  │     │                         │             │
└───────────────────────────│─────│─────────────────────────│─────────────┘
                            │     │                         │
                            v     v                         v
┌─────────────────────────────────────────────────────────────────────────┐
│                    Client State (useRepoWorkspace)                      │
│                                                                         │
│   Repo snapshot: source of truth for current workspace (excl. editor)   │
│                                                                         │
│   repoSidebarFiles  ◄──── replaceRepoSnapshot(files)                    │
│   ─────────────────       Source of truth for what is committed on      │
│                           GitHub; the UI reads this as the base repo    │
│                           tree before any terminal overlay is applied.  │
│                                                                         │
│   Terminal base files: snapshot bidirectionally synced w/ the terminal  │
│                                                                         │
│   terminalBaseFiles ◄──── replaceTerminalBaseSnapshot(key, files)       │
│   ─────────────────       Baseline snapshot synced into the terminal;   │
│                           diffs are computed against this state to      │
│                           detect terminal-made changes.                 │
│                                                                         │
│   Terminal overlay: Files staged on top of the current repo tree        │
│                                                                         │
│   overlayFilesByPath ◄──── applyTerminalImportDiffToWorkspace           │
│   deletedBaseFilesByPath   (called every 3s by TerminalPanel auto-      │
│   renamedBaseFilesByFrom   import + on pane switch/toggle)              │
│   ──────────────────────                                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
           │                  │                   │                   │
           v                  v                   v                   v
┌──────────────────┐ ┌────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│     Sidebar      │ │     Editor     │ │   Content View   │ │  Terminal Panel  │
│                  │ │                │ │                  │ │                  │
│ Builds the file  │ │ Holds the live │ │ Renders parsed   │ │ WebContainer FS  │
│ list from the    │ │ buffer and the │ │ markdown from    │ │ runs separately  │
│ effective repo   │ │ last saved     │ │ committed repo   │ │ from the editor. │
│ tree plus route  │ │ document       │ │ content.         │ │                  │
│ state.           │ │ content.       │ │                  │ │ Diffs actual FS  │
│                  │ │                │ │ Post-save        │ │ against the      │
│ Shows terminal   │ │ Save writes    │ │ verification     │ │ terminal base    │
│ overlay state.   │ │ directly via   │ │ delays reloads   │ │ snapshot and     │
│                  │ │ GitHub APIs.   │ │ until sha        │ │ imports changes  │
│ Rename/delete    │ │ Does not       │ │ catches up.      │ │ into overlay.    │
│ calls GitHub     │ │ flush the      │ │                  │ │                  │
│ directly.        │ │ terminal       │ │                  │ │ On discard,      │
│                  │ │ overlay.       │ │                  │ │ overlay is       │
│ Commit/Discard   │ │                │ │                  │ │ absorbed into    │
│ acts on terminal │ │                │ │                  │ │ the base         │
│ overlay only.    │ │                │ │                  │ │ snapshot.        │
└──────────────────┘ └────────────────┘ └──────────────────┘ └──────────────────┘
```

## Recommended Improvements

**Cross-tab handling of changed overlay snapshots.** We currently
perform no locking or special handling; changes in user configuration in
one tab may clobber other tabs unpredictably.

This seems okay for now because of the structure of credentials and
session files, and because we use per-file upsert to apply changes,
but it should be handled later.
