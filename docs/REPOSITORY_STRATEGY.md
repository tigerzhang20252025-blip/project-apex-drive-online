# Git Repository Management and Collaboration Strategy

This document records the long-term Git repository architecture, remote layout, collaboration workflow, deployment separation, and multi-agent coordination rules for Project Apex Drive.

## 1. Repository Structure

| Repository | URL | Role |
| --- | --- | --- |
| `project-apex-drive-online` | `https://github.com/tigerzhang20252025-blip/project-apex-drive-online` | Primary independent online development, release, and deployment repository. Owner controls development, release schedule, and production infrastructure independently of upstream PRs. |
| `project-apex-drive-offline` | `https://github.com/tigerzhang20252025-blip/project-apex-drive-offline` | Independent offline distribution repository. Must remain playable without internet. Preserves local assets, runtime dependencies, launch tools, and offline-specific packaging. Receives selective gameplay syncs from `online`. Publish distributable bundles via GitHub Releases rather than committing unnecessary large binaries to Git history. |
| `project-apex-drive-collab` | `https://github.com/tigerzhang20252025-blip/project-apex-drive-collab` | Existing GitHub fork of `https://github.com/jinyuze2028-source/project-apex-drive` dedicated to upstream collaboration and selective contributions. Do not detach this fork or create unnecessary extra repositories. |

## Open the development workspace

The only permanent development workspaces are `project-apex-drive-online` and `project-apex-drive-offline`. Open the appropriate folder directly in Antigravity or Codex. Each checkout has its own Git history, installed dependencies, and local vehicles. Use `feat/online-multiplayer` in the online checkout for the current development baseline. The online `main` branch tracks the stable release history.

The collaboration fork remains on GitHub. When an upstream contribution is explicitly authorized, create the contribution branch in the online checkout from `upstream/develop` and use its `collab` remote for that branch. The historical collaboration checkout is retained for recovery.

## 2. Git Remote Configuration

Always inspect `git remote -v` and verify the working directory before running Git commands.

- **`project-apex-drive-online` checkout**:
  - `origin`: `https://github.com/tigerzhang20252025-blip/project-apex-drive-online.git`
  - `upstream`: `https://github.com/jinyuze2028-source/project-apex-drive.git`
  - `collab`: `https://github.com/tigerzhang20252025-blip/project-apex-drive-collab.git`
  - The default push remote is `origin` and the push mode is `simple`. `upstream` has a local-only disabled push URL (`file:///dev/null`). Use `collab` explicitly for approved contribution branches.
- **`project-apex-drive-offline` checkout**:
  - `origin`: `https://github.com/tigerzhang20252025-blip/project-apex-drive-offline.git`
  - Optional fetch-only `online` remote (`git remote add online ...` with `git remote set-url --push online no_push`) to selectively import shared gameplay improvements without pushing multiplayer/CI-only changes back or pushing offline commits to `online`.

## 3. Branching Strategy

Use practical conventions rather than rigid rules when the repository state suggests a better fit:

- `main`: stable, release-ready code
- `feat/*`: feature development
- `fix/*`: bug fixes
- `release/*`: release preparation and validation
- `contrib/*`: focused upstream contribution branches

Keep commits focused and logically organized. Do not mix unrelated gameplay changes, deployment configuration, and large-scale refactoring into a single commit.

## 4. Upstream Collaboration Workflow

When contributing selective improvements back to `jinyuze2028-source/project-apex-drive`:

1. Fetch the latest upstream changes (`git fetch upstream`).
2. Create a clean contribution branch from `upstream/develop` (e.g., `git switch -c contrib/<topic> upstream/develop`), following [CONTRIBUTING.md](../CONTRIBUTING.md).
3. Selectively transfer only the relevant improvements (e.g., `git cherry-pick` or targeted patches).
4. Review the complete diff against `upstream/develop` (`git diff upstream/develop...HEAD`). Exclude owner-specific deployment configuration, infrastructure settings, and unrelated modifications.
5. Run appropriate checks (`npm run assets:fetch`, `npm run build`, `npm test`, and vehicle/browser verification as needed).
6. Push the contribution branch to `collab` (`git push -u collab contrib/<topic>`) only when authorized.
7. Open a focused pull request against `upstream` (`develop`) only when explicitly requested.

Never submit the entire independent development or `main` branch as an upstream pull request. Conversely, selectively integrate upstream improvements into `online` or `offline` only after reviewing compatibility.

## 5. Independent Deployment

- Public online game URL: `https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/`
- Deployment infrastructure is independent of the original repository's Cloudflare or Netlify setup.
- Keep reusable game functionality separate from owner-specific deployment configuration wherever practical.
- Never commit deployment credentials, private tokens, or production secrets.
- Note: [CONTRIBUTING.md](../CONTRIBUTING.md) and [docs/RELEASING.md](RELEASING.md) originate from upstream and document the original repository's `develop`-based PR and Netlify release workflow. Treat them as upstream reference rather than constraints on independent `online` or `offline` releases.

## 6. Development Continuity and Preserving Existing Work

Antigravity is the primary coding agent. Codex is an additional agent. Development is sequential in the two shared checkouts. Before starting any task:

1. Confirm the active repository and working directory.
2. Inspect `git status -sb`, `git branch -a`, `git worktree list`, and recent commits (`git log -n 10 --oneline --decorate`).
3. Check for existing uncommitted changes across active worktrees.
4. Review and reuse suitable existing implementations and preserve completed work while applying independent engineering judgment.
5. Do not overwrite, revert, or duplicate existing work without investigating it first.
6. Work on branches in the existing checkout. External worktrees and separate agent copies are prohibited. Keep essential resources and Git metadata within the workspace, report access restrictions, and keep historical archives for recovery.
7. Run the relevant tests and leave a clear Git status and a brief handover for the next agent.

## 7. Git Safety Rules

- Preserve existing uncommitted work.
- Do not perform destructive Git operations (`reset --hard`, `clean -fd`, `branch -D`, deleting worktrees with edits) without explicit approval.
- Do not force-push or rewrite shared Git history without explicit approval.
- Do not push directly to `jinyuze2028-source/project-apex-drive` (`upstream`).
- Do not open pull requests without explicit approval.
- Do not deploy to production without explicit approval.
- Preserve original project attribution, `LICENSE`, and third-party asset credits (`THIRD_PARTY_NOTICES.md`); verify redistribution rights before publishing third-party assets.
