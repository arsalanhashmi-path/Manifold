<div align="center">

# 🌌 Manifold

### One-command full-stack provisioning inside VS Code Chat

[![VS Code Extension](https://img.shields.io/badge/VS_Code-Extension-007ACC?style=for-the-badge&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=PathSystems.manifold)
[![Node.js](https://img.shields.io/badge/Node.js-LTS-339933?style=for-the-badge&logo=nodedotjs)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Backend-3ECF8E?style=for-the-badge&logo=supabase)](https://supabase.com/)
[![Vercel](https://img.shields.io/badge/Vercel-Deployment-000000?style=for-the-badge&logo=vercel)](https://vercel.com/)
[![GitHub](https://img.shields.io/badge/GitHub-Provisioning-181717?style=for-the-badge&logo=github)](https://github.com/)

**From** `@manifold setup my-app` **to a deployed full-stack app.**

</div>

---

## What is Manifold?

Manifold is a VS Code chat participant that turns this:

```text
@manifold setup my-app
```

into a guided provisioning pipeline that:

1. checks your machine,
2. validates auth,
3. scaffolds a React + Supabase app,
4. provisions GitHub + Vercel,
5. wires environment variables, and
6. deploys frontend + backend.

Manifold persists run progress in `.manifold.json`, so the setup state is traceable and resumable.

---

## What this extension does

- Adds a chat participant: `@manifold`
- Stores run progress in `.manifold.json`
- Runs environment checks for:
	- `git`
	- `node`
	- `python`
	- `gh` (GitHub CLI)
	- `vercel` (Vercel CLI)
	- `supabase` (Supabase CLI)
- Verifies authentication for GitHub, Vercel, and Supabase
- Scaffolds app structure (`frontend` + `supabase/functions`)
- Provisions GitHub repo + Vercel project
- Writes env files (`.env`, `frontend/.env`)
- Deploys frontend to Vercel and backend function to Supabase

---

## Required accounts (must have)

You need these accounts before running setup:

| Account      | Why it is required                              | Minimum needed                                           |
| :----------- | :---------------------------------------------- | :------------------------------------------------------- |
| **GitHub**   | Creates and pushes project repository           | Account with permission to create private repos          |
| **Vercel**   | Creates project, links it, and deploys frontend | Account connected to CLI login                           |
| **Supabase** | Verifies credentials and deploys Edge Function  | Project using either PAT + Project URL + Publishable Key |

Recommended:

- Keep all three accounts under the same email/org context for easier permission handling.

---

## Software to install on your computer

### Core tools

- **Git**
- **Node.js (LTS)** and **npm**
- **Python 3.11+**
- **GitHub CLI** (`gh`)
- **Vercel CLI** (`vercel`)
- **Supabase CLI** (`supabase`, or `npx supabase` fallback)
- **VS Code** (latest stable)

### Windows install commands

```powershell
winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements
winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements
npm install -g vercel
npm install supabase --save-dev
```

---

## First-time auth setup (one-time)

Run these before using `@manifold`:

```powershell
gh auth login
vercel login
```

For Supabase, use these methods when prompted by Manifold:

1. **Personal Access Token** (`sbp_...`)
2. **Project URL + Publishable API Key** (`https://<ref>.supabase.co` + `sb_publishable_...`)

---

## Quick start

In VS Code Chat:

```text
@manifold setup my-app
```

Manifold will guide each phase in order and report progress as it provisions and deploys.

---

## Deploy updates with one command

After setup is complete, you can deploy new changes anytime with:

```text
@manifold deploy
```

Or target a specific scaffolded project name:

```text
@manifold deploy my-app
```

### What deploy does

- Verifies GitHub CLI and Vercel CLI authentication
- Finds your project folder (either current workspace root or `<workspace>/<project-name>`)
- Stages and commits local changes
- Pushes to GitHub
- Deploys frontend to Vercel
- Deploys updated Supabase Edge Function (`api`)

### Requirements for deploy

- Setup must have run at least once so `.manifold.json` contains project/resource state
- You must be authenticated with:
	- `gh auth login`
	- `vercel login`
- Supabase access token must be available from the setup flow

