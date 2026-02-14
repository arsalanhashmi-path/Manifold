import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EnvWriteResult {
  filePath: string;
  keys: string[];
}

function upsertEnvContent(content: string, values: Record<string, string>): string {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const indexByKey = new Map<string, number>();

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || !trimmed.includes("=")) {
      return;
    }

    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (key.length > 0) {
      indexByKey.set(key, index);
    }
  });

  for (const [key, value] of Object.entries(values)) {
    const nextLine = `${key}=${value}`;
    const existingIndex = indexByKey.get(key);
    if (typeof existingIndex === "number") {
      lines[existingIndex] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  return `${lines.filter((line) => line !== undefined).join("\n").replace(/\n+$/g, "")}\n`;
}

async function writeEnvFile(filePath: string, values: Record<string, string>): Promise<EnvWriteResult> {
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  const next = upsertEnvContent(content, values);
  await fs.writeFile(filePath, next, "utf8");

  return {
    filePath,
    keys: Object.keys(values)
  };
}

export async function wireProjectEnvironment(
  projectRoot: string,
  options: {
    supabaseUrl: string;
    supabasePublishableKey: string;
    githubRepo: string;
    vercelProjectId: string;
  }
): Promise<EnvWriteResult[]> {
  const rootEnv = await writeEnvFile(path.join(projectRoot, ".env"), {
    SUPABASE_URL: options.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: options.supabasePublishableKey,
    GITHUB_REPO: options.githubRepo,
    VERCEL_PROJECT_ID: options.vercelProjectId
  });

  const frontendEnv = await writeEnvFile(path.join(projectRoot, "frontend", ".env"), {
    VITE_SUPABASE_URL: options.supabaseUrl,
    VITE_SUPABASE_PUBLISHABLE_KEY: options.supabasePublishableKey
  });

  return [rootEnv, frontendEnv];
}
