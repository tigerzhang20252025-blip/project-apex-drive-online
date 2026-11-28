# Browser automation

- Run all automated browser checks in headless mode. Use `headless: true` with Playwright, Puppeteer, and any equivalent tool. In this project, import `launchTestBrowser` from `scripts/test-browser.mjs` for Playwright tests.
- Launch a separate browser instance with an isolated profile. Keep the user's browser windows, tabs, profiles, foreground application, and desktop untouched. Avoid focus commands such as `bringToFront()`.
- Use headless screenshots for visual review. Continue testing keyboard and mouse input, JavaScript, WebGL rendering, gameplay, and published URLs as part of authorized work.
- Close each test-owned browser in a `finally` block, including on assertion or setup failures. Close only the browser instance that the current test launched.
- Apply the same rules to browser MCP servers. Verify headless launch and isolation before use. If the server cannot satisfy either requirement, use the project's standalone runner.
- If a necessary check remains blocked after reasonable headless troubleshooting, ask for explicit permission before opening a visible browser. Wait for approval. Use a separate test instance if approved.

# Project Apex Drive — Technical Rules

- Use the existing Three.js and TypeScript architecture, Rapier for vehicle dynamics, and Vite for the web build.
- Keep changes focused. Check both vehicles when editing shared systems. Verify driving behavior and rendering with real measurements.
- Run `npm run assets:fetch`, `npm run build` and `npm test` before requesting review or release.
- Track third-party licenses (`THIRD_PARTY_NOTICES.md`, `LICENSE`) and keep vehicle GLBs, login data, credentials, private tokens, and local evidence outside Git. Verify redistribution rights before publishing third-party assets.

# Git Repository Management and Collaboration Strategy

See [docs/REPOSITORY_STRATEGY.md](docs/REPOSITORY_STRATEGY.md) for full details and command checklists.

## Repositories and Remotes

- `project-apex-drive-online` (`tigerzhang20252025-blip/project-apex-drive-online`): Primary independent online development, release, and deployment repository. Updating and releasing the online game does not require upstream PR approval.
  - Intended remotes: `origin` (`project-apex-drive-online`), `upstream` (`jinyuze2028-source/project-apex-drive`), `collab` (`project-apex-drive-collab`).
- `project-apex-drive-offline` (`tigerzhang20252025-blip/project-apex-drive-offline`): Independent offline distribution repository. Must remain playable without internet; preserve local assets, runtime dependencies, launch tools, and offline-specific packaging; selectively sync shared gameplay improvements from `online`; prefer GitHub Releases over committing large distributable bundles into Git history.
  - Intended remotes: own `origin` (`project-apex-drive-offline`), plus an optional fetch-only remote pointing to `project-apex-drive-online`.
- `project-apex-drive-collab` (`tigerzhang20252025-blip/project-apex-drive-collab`): Existing GitHub fork of `jinyuze2028-source/project-apex-drive` dedicated to upstream collaboration and selective contributions. Do not detach this fork or create unnecessary extra repositories.
- Always run `git remote -v` and verify the local repository path before any Git operation. Never assume the current repository or remote is correct.

## Branching and Commits

- Practical branch conventions: `main` (stable release-ready), `feat/*`, `fix/*`, `release/*`, `contrib/*`.
- Keep commits focused and logically organized. Do not mix unrelated gameplay changes, deployment configuration, and large-scale refactoring in a single commit.

## Upstream Collaboration and Independent Deployment

- Upstream PRs go through `contrib/*` branched from `upstream/develop`, containing only selectively transferred, tested improvements reviewed against `upstream`, pushed to `collab` when authorized, and opened as focused PRs only when explicitly requested. Never submit the full independent development/production branch or personal deployment/infrastructure config upstream.
- Selectively integrate upstream improvements into own repositories only after reviewing compatibility.
- Public online game URL: `https://apex-drive-network-poc.tigerzhang0215.workers.dev/play/`. Keep deployment infrastructure independent of the original project's Cloudflare/Netlify setup and keep reusable gameplay separate from owner-specific deployment settings where practical.

## Development Continuity and Preserving Existing Work

- Antigravity is the sole active coding agent for Project Apex Drive.
- Open `project-apex-drive-online` itself as the Antigravity workspace for online work. Use this checkout’s own Git metadata, assets, dependencies and relay. Historical archives and detached test directories are recovery material.
- Before starting any task: confirm the local repository and working directory, inspect `git branch`, `git status`, `git worktree list`, and recent commits, and check for existing or uncommitted work.
- Reuse suitable existing implementations and preserve completed or uncommitted work while exercising independent engineering judgment. Do not overwrite, revert, or duplicate existing work without investigating it first. Use isolated branches or temporary worktrees only when separate isolation is needed.

## Git Safety Rules

- Preserve existing uncommitted work.
- Never run destructive Git operations, force-push, or rewrite shared history without explicit approval.
- Never push directly to `upstream` (`jinyuze2028-source/project-apex-drive`).
- Never open pull requests or deploy to production without explicit approval.
- Preserve original project attribution and licensing notices.
