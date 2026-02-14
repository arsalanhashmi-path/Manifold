import { exec } from "node:child_process";
import * as path from "node:path";

export interface ProvisionResult {
  ok: boolean;
  githubRepo: string | null;
  vercelProjectId: string | null;
  rollbackStack: string[];
  output: string[];
}

interface CommandResult {
  ok: boolean;
  output: string;
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/\\-]+$/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, "\\\"")}"`;
}

function run(command: string, args: string[], cwd: string, timeoutMs = 90_000): Promise<CommandResult> {
  const commandLine = `${command} ${args.map(quoteArg).join(" ")}`.trim();
  return new Promise((resolve) => {
    exec(commandLine, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        output: `${stdout ?? ""}${stderr ?? ""}`.trim()
      });
    });
  });
}

async function runRollback(rollbackStack: string[], cwd: string, output: string[]): Promise<void> {
  while (rollbackStack.length > 0) {
    const command = rollbackStack.pop();
    if (!command) {
      continue;
    }

    const result = await new Promise<CommandResult>((resolve) => {
      exec(command, { cwd, timeout: 90_000 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          output: `${stdout ?? ""}${stderr ?? ""}`.trim()
        });
      });
    });

    output.push(`rollback ${result.ok ? "✅" : "⚠️"}: ${command}`);
    if (result.output) {
      output.push(result.output);
    }
  }
}

async function ensureGitRepository(projectRoot: string, output: string[]): Promise<void> {
  const check = await run("git", ["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (check.ok) {
    return;
  }

  const init = await run("git", ["init"], projectRoot);
  if (!init.ok) {
    throw new Error(`Git initialization failed: ${init.output}`);
  }

  const setMain = await run("git", ["branch", "-M", "main"], projectRoot);
  if (!setMain.ok) {
    output.push(`warning: could not set default branch to main: ${setMain.output}`);
  }

  output.push("git repository initialized for scaffolded project");
}

async function ensureInitialCommit(projectRoot: string, output: string[]): Promise<boolean> {
  const hasHead = await run("git", ["rev-parse", "--verify", "HEAD"], projectRoot);
  if (hasHead.ok) {
    return true;
  }

  const addAll = await run("git", ["add", "."], projectRoot);
  if (!addAll.ok) {
    output.push(`warning: could not stage files for initial commit: ${addAll.output}`);
    return false;
  }

  const addBackend = await run(
    "git",
    [
      "add",
      "-f",
      "supabase/functions/",
      "supabase/config.toml",
      "vercel.json",
      "frontend/src/",
      "frontend/package.json"
    ],
    projectRoot
  );
  if (!addBackend.ok) {
    output.push(`warning: could not force-add source files: ${addBackend.output}`);
  }

  const commit = await run("git", ["commit", "-m", "Initial scaffold"], projectRoot);
  if (!commit.ok) {
    output.push(`warning: initial commit skipped: ${commit.output}`);
    return false;
  }

  output.push("initial git commit created");
  return true;
}

async function ensureGitHubRepo(projectName: string, projectRoot: string, output: string[], rollbackStack: string[]): Promise<string> {
  await ensureGitRepository(projectRoot, output);

  const ownerResult = await run("gh", ["api", "user", "--jq", ".login"], projectRoot);
  if (!ownerResult.ok || ownerResult.output.length === 0) {
    throw new Error(`Unable to resolve GitHub login: ${ownerResult.output || "unknown error"}`);
  }

  const owner = ownerResult.output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (!owner) {
    throw new Error("Unable to resolve GitHub login.");
  }

  const fullRepo = `${owner}/${projectName}`;
  const repoExists = await run("gh", ["repo", "view", fullRepo, "--json", "name"], projectRoot);
  if (repoExists.ok) {
    output.push(`github repo exists: ${fullRepo}`);
    return fullRepo;
  }

  const createRepo = await run(
    "gh",
    ["repo", "create", projectName, "--private", "--source", ".", "--remote", "origin"],
    projectRoot,
    180_000
  );

  if (!createRepo.ok) {
    throw new Error(`GitHub repo creation failed: ${createRepo.output}`);
  }

  output.push(`github repo created: ${fullRepo}`);
  rollbackStack.push(`gh repo delete ${fullRepo} --yes`);

  const canPush = await ensureInitialCommit(projectRoot, output);
  if (canPush) {
    const push = await run("git", ["push", "-u", "origin", "HEAD"], projectRoot, 180_000);
    if (!push.ok) {
      output.push(`warning: git push failed: ${push.output}`);
    } else {
      output.push("git remote push completed");
    }
  }

  return fullRepo;
}

async function ensureVercelProject(projectName: string, projectRoot: string, output: string[], rollbackStack: string[]): Promise<string> {
  const inspect = await run("vercel", ["project", "inspect", projectName], projectRoot);
  let created = false;

  if (!inspect.ok) {
    const add = await run("vercel", ["project", "add", projectName], projectRoot, 180_000);
    if (!add.ok && !/already exists/i.test(add.output)) {
      throw new Error(`Vercel project creation failed: ${add.output}`);
    }

    created = !/already exists/i.test(add.output);
    output.push(created ? `vercel project created: ${projectName}` : `vercel project exists: ${projectName}`);
  } else {
    output.push(`vercel project exists: ${projectName}`);
  }

  const link = await run("vercel", ["link", "--yes", "--project", projectName], projectRoot, 180_000);
  if (!link.ok && !/already linked|linked to/i.test(link.output)) {
    throw new Error(`Vercel link failed: ${link.output}`);
  }

  output.push(`vercel project linked to ${projectRoot}`);
  if (created) {
    rollbackStack.push(`vercel project rm ${projectName} --yes`);
  }

  return projectName;
}

export async function runProvisioning(projectRoot: string, projectName: string): Promise<ProvisionResult> {
  const rollbackStack: string[] = [];
  const output: string[] = [];

  try {
    const githubRepo = await ensureGitHubRepo(projectName, projectRoot, output, rollbackStack);
    const vercelProjectId = await ensureVercelProject(projectName, projectRoot, output, rollbackStack);

    return {
      ok: true,
      githubRepo,
      vercelProjectId,
      rollbackStack,
      output
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.push(message);
    await runRollback(rollbackStack, projectRoot, output);
    return {
      ok: false,
      githubRepo: null,
      vercelProjectId: null,
      rollbackStack,
      output
    };
  }
}
