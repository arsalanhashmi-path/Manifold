import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";

export type ToolKey = "git" | "node" | "python" | "gh" | "vercel" | "supabase";

export interface ToolCheckResult {
  tool: ToolKey;
  ok: boolean;
  output: string;
  installHint: string;
}

export interface EnvCheckReport {
  platform: NodeJS.Platform;
  tools: ToolCheckResult[];
}

export interface InstallAttempt {
  tool: ToolKey;
  attempted: boolean;
  ok: boolean;
  method: "primary" | "fallback" | "manual";
  output: string;
  pathAddition?: string;
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/\\-]+$/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, "\\\"")}"`;
}

function run(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  const commandLine = `${command} ${args.map(quoteArg).join(" ")}`.trim();
  return new Promise((resolve) => {
    exec(commandLine, { timeout: 12000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve({ ok: !error, output });
    });
  });
}

function appendToPathIfMissing(candidatePath: string): void {
  if (!candidatePath) {
    return;
  }

  const current = process.env.PATH ?? "";
  const entries = current.split(path.delimiter).filter(Boolean);
  const exists = entries.some((entry) => entry.toLowerCase() === candidatePath.toLowerCase());
  if (!exists) {
    process.env.PATH = `${candidatePath}${path.delimiter}${current}`;
  }
}

async function refreshNodeGlobalBinPath(): Promise<void> {
  const npmPrefix = await run("npm", ["config", "get", "prefix"]);
  if (!npmPrefix.ok) {
    return;
  }

  const prefix = npmPrefix.output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!prefix) {
    return;
  }

  if (os.platform() === "win32") {
    appendToPathIfMissing(prefix);
    appendToPathIfMissing(path.join(prefix, "node_modules", ".bin"));
    return;
  }

  appendToPathIfMissing(path.join(prefix, "bin"));
}

async function checkPython(): Promise<{ ok: boolean; output: string }> {
  const direct = await run("python", ["--version"]);
  if (direct.ok) {
    return direct;
  }

  if (os.platform() === "win32") {
    const py = await run("py", ["-V"]);
    if (py.ok) {
      return py;
    }
  }

  return direct;
}

async function checkVercel(): Promise<{ ok: boolean; output: string }> {
  const direct = await run("vercel", ["--version"]);
  if (direct.ok) {
    return direct;
  }

  if (os.platform() === "win32") {
    const cmdDirect = await run("vercel.cmd", ["--version"]);
    if (cmdDirect.ok) {
      return cmdDirect;
    }
  }

  await refreshNodeGlobalBinPath();

  const retry = await run("vercel", ["--version"]);
  if (retry.ok) {
    return retry;
  }

  if (os.platform() === "win32") {
    return run("vercel.cmd", ["--version"]);
  }

  return retry;
}

async function checkSupabase(): Promise<{ ok: boolean; output: string }> {
  const direct = await run("supabase", ["--version"]);
  if (direct.ok) {
    return direct;
  }

  if (os.platform() === "win32") {
    const cmdDirect = await run("supabase.cmd", ["--version"]);
    if (cmdDirect.ok) {
      return cmdDirect;
    }
  }

  // Try npx for local installation
  const npx = await run("npx", ["supabase", "--version"]);
  if (npx.ok) {
    return npx;
  }

  await refreshNodeGlobalBinPath();

  const retry = await run("supabase", ["--version"]);
  if (retry.ok) {
    return retry;
  }

  if (os.platform() === "win32") {
    const cmdRetry = await run("supabase.cmd", ["--version"]);
    if (cmdRetry.ok) {
      return cmdRetry;
    }
  }

  // Final fallback to npx
  return run("npx", ["supabase", "--version"]);
}

function getInstallHint(tool: ToolKey, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const map: Record<ToolKey, string> = {
      git: "winget install git.git",
      node: "winget install OpenJS.NodeJS.LTS",
      python: "winget install Python.Python.3.11",
      gh: "winget install GitHub.cli",
      vercel: "npm install -g vercel",
      supabase: "npm i supabase --save-dev"
    };
    return map[tool];
  }

  if (platform === "darwin") {
    const map: Record<ToolKey, string> = {
      git: "xcode-select --install",
      node: "brew install node",
      python: "brew install python",
      gh: "brew install gh",
      vercel: "npm install -g vercel",
      supabase: "npm i supabase --save-dev"
    };
    return map[tool];
  }

  const map: Record<ToolKey, string> = {
    git: "Install via your distro package manager (apt/dnf/pacman)",
    node: "Install Node.js LTS via your distro package manager or nvm",
    python: "Install Python 3.11+ via your distro package manager",
    gh: "Install GitHub CLI via your distro package manager",
    vercel: "npm install -g vercel",
    supabase: "npm i supabase --save-dev"
  };
  return map[tool];
}

function getInstallCommand(tool: ToolKey, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    const map: Record<ToolKey, string> = {
      git: "winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements",
      node: "winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements",
      python: "winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements",
      gh: "winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements",
      vercel: "npm install -g vercel",
      supabase: "npm i supabase --save-dev"
    };
    return map[tool];
  }

  if (platform === "darwin") {
    const map: Record<ToolKey, string> = {
      git: "xcode-select --install",
      node: "brew install node",
      python: "brew install python",
      gh: "brew install gh",
      vercel: "npm install -g vercel",
      supabase: "npm i supabase --save-dev"
    };
    return map[tool];
  }

  if (tool === "vercel") {
    return "npm install -g vercel";
  }

  if (tool === "supabase") {
    return "npm i supabase --save-dev";
  }

  return null;
}

function runShell(command: string, timeoutMs = 180_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve({ ok: !error, output });
    });
  });
}

export async function installMissingTool(
  tool: ToolKey,
  platform: NodeJS.Platform,
  options?: { globalStoragePath?: string; onCommand?: (command: string) => void }
): Promise<InstallAttempt> {
  const primary = getInstallCommand(tool, platform);
  if (!primary) {
    return {
      tool,
      attempted: false,
      ok: false,
      method: "manual",
      output: `Manual install required. Suggested: ${getInstallHint(tool, platform)}`
    };
  }

  options?.onCommand?.(primary);
  const primaryResult = await runShell(primary);
  if (primaryResult.ok) {
    return {
      tool,
      attempted: true,
      ok: true,
      method: "primary",
      output: primaryResult.output
    };
  }

  if (tool === "vercel" && options?.globalStoragePath) {
    const permissionIssue = /eacces|eperm|permission denied|access is denied/i.test(primaryResult.output);
    if (permissionIssue) {
      const localRoot = path.join(options.globalStoragePath, "tools", "vercel-local");
      await fs.mkdir(localRoot, { recursive: true });
      const fallback = `npm install vercel --prefix \"${localRoot}\"`;

      options?.onCommand?.(fallback);
      const fallbackResult = await runShell(fallback);
      if (fallbackResult.ok) {
        const binDir = path.join(localRoot, "node_modules", ".bin");
        return {
          tool,
          attempted: true,
          ok: true,
          method: "fallback",
          output: fallbackResult.output,
          pathAddition: binDir
        };
      }

      return {
        tool,
        attempted: true,
        ok: false,
        method: "fallback",
        output: fallbackResult.output
      };
    }
  }

  return {
    tool,
    attempted: true,
    ok: false,
    method: "primary",
    output: primaryResult.output
  };
}

export async function runEnvironmentChecks(): Promise<EnvCheckReport> {
  const platform = os.platform();

  const checks: Record<ToolKey, Promise<{ ok: boolean; output: string }>> = {
    git: run("git", ["--version"]),
    node: run("node", ["-v"]),
    python: checkPython(),
    gh: run("gh", ["--version"]),
    vercel: checkVercel(),
    supabase: checkSupabase()
  };

  const tools = await Promise.all(
    (Object.keys(checks) as ToolKey[]).map(async (tool) => {
      const result = await checks[tool];
      return {
        tool,
        ok: result.ok,
        output: result.output,
        installHint: getInstallHint(tool, platform)
      };
    })
  );

  return { platform, tools };
}
