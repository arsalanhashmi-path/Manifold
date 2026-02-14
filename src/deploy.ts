import { exec } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface DeploymentError {
  line: string;
  type: "build" | "env" | "config" | "network" | "unknown";
  suggestion: string;
}

export interface DeploymentResult {
  ok: boolean;
  frontendUrl: string | null;
  publicUrl: string | null;
  backendUrl: string | null;
  logs: string[];
  errors: DeploymentError[];
  command?: string;
  logFilePath?: string;
}

export interface EnvUpdateResult {
  ok: boolean;
  logFilePath?: string;
}

export interface AliasLookupResult {
  alias: string | null;
  logFilePath?: string;
}

function parseDeploymentLog(logs: string[]): DeploymentError[] {
  const errors: DeploymentError[] = [];
  const text = logs.join("\n").toLowerCase();

  if (/error|failed|cannot find|not found|enoent/.test(text)) {
    const lines = logs.filter(
      (line) =>
        /error|failed|cannot find|not found|enoent|missing|undefined|null/.test(line.toLowerCase())
    );

    for (const line of lines.slice(0, 5)) {
      let type: DeploymentError["type"] = "unknown";
      let suggestion = "Review the logs above and fix the issue, then redeploy.";

      if (/env|environment|secret|api[_-]key/.test(line.toLowerCase())) {
        type = "env";
        suggestion = "Check that all required environment variables are set in Vercel project settings.";
      } else if (/build|compile|syntax|npm|python|module|package/.test(line.toLowerCase())) {
        type = "build";
        suggestion = "Run `npm run build` or `pip install` locally to debug build issues.";
      } else if (/config|vercel\.json|next\.config/.test(line.toLowerCase())) {
        type = "config";
        suggestion = "Check your project configuration files (vercel.json, package.json, etc.).";
      } else if (/timeout|econnrefused|network|dns|connection/.test(line.toLowerCase())) {
        type = "network";
        suggestion = "Check network connectivity and firewall rules for external API calls.";
      }

      errors.push({ line, type, suggestion });
    }
  }

  return errors;
}

function extractDeploymentUrl(logs: string[]): string | null {
  const text = logs.join("\n");
  const urlPatterns = [
    /(?:https?:\/\/)?([a-z0-9-]+\.vercel\.app)/i,
    /(?:https?:\/\/)?([a-z0-9-]+\.web\.app)/i,
    /(?:production\s+)?url:?\s+(https?:\/\/[^\s]+)/i
  ];

  for (const pattern of urlPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].startsWith("http") ? match[1] : `https://${match[1]}`;
      if (/vercel\.app|web\.app/.test(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function extractVercelPublicUrl(logs: string[]): string | null {
  const text = logs.join("\n");
  const aliasedMatch = text.match(/Aliased:\s*(https?:\/\/[^\s]+)/i);
  if (aliasedMatch && aliasedMatch[1]) {
    return aliasedMatch[1];
  }

  const readyMatch = text.match(/(?:^|\n)\s*https?:\/\/[^\s]*\.vercel\.app\s*$/im);
  if (readyMatch && readyMatch[0]) {
    return readyMatch[0].trim();
  }

  return null;
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/\\-]+$/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, "\\\"")}"`;
}

async function writeLog(projectRoot: string, name: string, lines: string[]): Promise<string> {
  const logDir = path.join(projectRoot, ".manifold-logs");
  const logFile = path.join(logDir, `${name}-${Date.now()}.log`);
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logFile, lines.join("\n") + "\n", "utf8");
  } catch {
    return logFile;
  }
  return logFile;
}

async function runEnvCommand(
  projectRoot: string,
  commandLine: string,
  logs: string[]
): Promise<boolean> {
  return new Promise((resolve) => {
    exec(commandLine, { cwd: projectRoot, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      const combined = `${stdout ?? ""}${stderr ?? ""}`;
      const lines = combined.split(/\r?\n/).filter(Boolean);
      logs.push(`$ ${commandLine}`);
      logs.push(...lines);
      resolve(!error);
    });
  });
}

export async function runVercelEnvUpdate(
  projectRoot: string,
  values: Record<string, string>,
  vercelToken?: string
): Promise<EnvUpdateResult> {
  const logs: string[] = [];
  const tokenArg = vercelToken ? ` --token=${quoteArg(vercelToken)}` : "";

  let ok = true;
  for (const [key, value] of Object.entries(values)) {
    if (!value) {
      continue;
    }

    const removeCommand = `vercel env rm ${key} production --yes${tokenArg}`;
    await runEnvCommand(projectRoot, removeCommand, logs);

    const addCommand = `vercel env add ${key} production --value ${quoteArg(value)}${tokenArg}`;
    const addOk = await runEnvCommand(projectRoot, addCommand, logs);
    if (!addOk) {
      ok = false;
    }
  }

  const logFilePath = await writeLog(projectRoot, "env", logs);
  return { ok, logFilePath };
}

export async function runVercelAliasLookup(
  projectRoot: string,
  vercelToken?: string
): Promise<AliasLookupResult> {
  const logs: string[] = [];
  const tokenArg = vercelToken ? ` --token=${quoteArg(vercelToken)}` : "";
  const commandLine = `vercel alias ls --json${tokenArg}`;

  const output = await new Promise<string>((resolve) => {
    exec(commandLine, { cwd: projectRoot, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const combined = `${stdout ?? ""}${stderr ?? ""}`.trim();
      logs.push(`$ ${commandLine}`);
      if (combined.length > 0) {
        logs.push(combined);
      }
      if (error) {
        resolve("");
        return;
      }
      resolve(combined);
    });
  });

  let alias: string | null = null;
  if (output) {
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) {
        const candidates = parsed
          .map((entry) => (typeof entry === "string" ? entry : entry?.alias || entry?.domain))
          .filter((entry: string | undefined) => typeof entry === "string" && entry.length > 0) as string[];
        alias = candidates.find((entry) => /\.vercel\.app$/i.test(entry)) ?? candidates[0] ?? null;
      }
    } catch {
      const matches = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /\.vercel\.app$/i.test(line));
      alias = matches[0] ?? null;
    }
  }

  const logFilePath = await writeLog(projectRoot, "alias", logs);
  return { alias, logFilePath };
}

export async function runDeployment(
  projectRoot: string,
  vercelToken?: string,
  supabaseAccessToken?: string,
  supabaseProjectRef?: string,
  onCommand?: (command: string) => void
): Promise<DeploymentResult> {
  const logs: string[] = [];
  const errors: DeploymentError[] = [];

  // Deploy frontend to Vercel
  logs.push("=== Deploying frontend to Vercel ===\n");
  const frontendResult = await new Promise<{ ok: boolean; url: string | null; publicUrl: string | null; logs: string[] }>((resolve) => {
    const args = ["deploy", "--prod", "--yes"];
    if (vercelToken) {
      args.push(`--token=${quoteArg(vercelToken)}`);
    }
    const commandLine = `vercel ${args.join(" ")}`;
    logs.push(`$ ${commandLine}`);
    logs.push("");
    onCommand?.(commandLine);

    exec(
      commandLine,
      { cwd: path.join(projectRoot, "frontend"), timeout: 600_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}${stderr ?? ""}`;
        const lines = combined.split(/\r?\n/).filter(Boolean);
        logs.push(...lines);

        if (error) {
          errors.push(...parseDeploymentLog(lines));
          return resolve({ ok: false, url: extractDeploymentUrl(lines), publicUrl: extractVercelPublicUrl(lines), logs: lines });
        }

        const url = extractDeploymentUrl(lines);
        const publicUrl = extractVercelPublicUrl(lines) ?? url;
        resolve({ ok: !!url, url, publicUrl, logs: lines });
      }
    );
  });

  logs.push("\n=== Deploying backend to Supabase Edge Functions ===\n");
  const backendResult = await new Promise<{ ok: boolean; url: string | null; logs: string[] }>((resolve) => {
    // Build command with project ref if available
    let commandLine = "npx supabase functions deploy api";
    if (supabaseProjectRef) {
      commandLine += ` --project-ref ${supabaseProjectRef}`;
    }
    logs.push(`$ ${commandLine}`);
    logs.push("");
    onCommand?.(commandLine);

    // Set SUPABASE_ACCESS_TOKEN environment variable if token is provided
    const env = { ...process.env };
    if (supabaseAccessToken) {
      env.SUPABASE_ACCESS_TOKEN = supabaseAccessToken;
    }

    exec(
      commandLine,
      { cwd: projectRoot, timeout: 600_000, maxBuffer: 10 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ""}${stderr ?? ""}`;
        const lines = combined.split(/\r?\n/).filter(Boolean);
        logs.push(...lines);

        if (error) {
          errors.push(...parseDeploymentLog(lines));
          return resolve({ ok: false, url: null, logs: lines });
        }

        // Extract Supabase function URL from output
        // Typically: "Deployed Function api version X"
        // URL format: https://<ref>.supabase.co/functions/v1/api
        resolve({ ok: true, url: null, logs: lines });
      }
    );
  });

  const logFile = await writeLog(projectRoot, "deploy", logs);

  return {
    ok: frontendResult.ok && backendResult.ok,
    frontendUrl: frontendResult.url,
    publicUrl: frontendResult.publicUrl,
    backendUrl: backendResult.url,
    logs,
    errors,
    logFilePath: logFile
  };
}
