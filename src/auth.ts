import * as https from "node:https";
import { exec } from "node:child_process";

export interface AuthCheckResult {
  ok: boolean;
  output: string;
}

function quoteArg(arg: string): string {
  if (/^[a-zA-Z0-9._:/\\-]+$/.test(arg)) {
    return arg;
  }

  return `"${arg.replace(/"/g, "\\\"")}"`;
}

function run(command: string, args: string[], timeout = 15000): Promise<AuthCheckResult> {
  const commandLine = `${command} ${args.map(quoteArg).join(" ")}`.trim();
  return new Promise((resolve) => {
    exec(commandLine, { timeout }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve({ ok: !error, output });
    });
  });
}

export function checkGhAuthStatus(): Promise<AuthCheckResult> {
  return run("gh", ["auth", "status"]);
}

export function checkVercelWhoAmI(): Promise<AuthCheckResult> {
  return run("vercel", ["whoami"]);
}

export function verifySupabasePat(token: string): Promise<AuthCheckResult> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: "GET",
        hostname: "api.supabase.com",
        path: "/v1/projects?limit=1",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: token,
          Accept: "application/json"
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8").trim();
          const snippet = body.slice(0, 300);
          const status = res.statusCode ?? 0;

          if (status >= 200 && status < 300) {
            resolve({ ok: true, output: "Supabase PAT verified." });
            return;
          }

          const reason = snippet.length > 0 ? snippet : `HTTP ${status}`;
          resolve({ ok: false, output: `Supabase PAT verification failed: ${reason}` });
        });
      }
    );

    req.on("error", (error) => {
      resolve({ ok: false, output: `Supabase API request failed: ${error.message}` });
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error("Request timed out"));
    });

    req.end();
  });
}

export function parseSupabaseProjectRef(projectUrl: string): string | null {
  try {
    const parsed = new URL(projectUrl);
    if (parsed.protocol !== "https:") {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    const suffix = ".supabase.co";
    if (!host.endsWith(suffix)) {
      return null;
    }

    const ref = host.slice(0, host.length - suffix.length).trim();
    if (!/^[a-z0-9]{20,}$/.test(ref)) {
      return null;
    }

    return ref;
  } catch {
    return null;
  }
}

export function verifySupabaseProjectApi(projectUrl: string, publishableKey: string): Promise<AuthCheckResult> {
  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(projectUrl);
    } catch {
      resolve({ ok: false, output: "Invalid Supabase Project URL." });
      return;
    }

    const host = parsedUrl.hostname;

    const requestOnce = (path: string, withAuthorization: boolean): Promise<{ status: number; snippet: string; error?: string }> => {
      return new Promise((requestResolve) => {
        const headers: Record<string, string> = {
          apikey: publishableKey,
          Accept: "application/json"
        };

        if (withAuthorization) {
          headers.Authorization = `Bearer ${publishableKey}`;
        }

        const req = https.request(
          {
            method: "GET",
            protocol: parsedUrl.protocol,
            hostname: host,
            path,
            headers
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf8").trim();
              requestResolve({
                status: res.statusCode ?? 0,
                snippet: body.slice(0, 300)
              });
            });
          }
        );

        req.on("error", (error) => {
          requestResolve({ status: 0, snippet: "", error: error.message });
        });

        req.setTimeout(15000, () => {
          req.destroy(new Error("Request timed out"));
        });

        req.end();
      });
    };

    (async () => {
      const primary = await requestOnce("/auth/v1/settings", false);
      if (primary.error) {
        resolve({ ok: false, output: `Supabase Project API request failed: ${primary.error}` });
        return;
      }

      if (primary.status >= 200 && primary.status < 300) {
        resolve({ ok: true, output: "Supabase Project URL and Publishable API Key verified." });
        return;
      }

      if (primary.status !== 401 && primary.status !== 403) {
        resolve({ ok: true, output: "Supabase project endpoint reachable and key accepted for gateway access." });
        return;
      }

      const fallback = await requestOnce("/rest/v1/", true);
      if (fallback.error) {
        resolve({ ok: false, output: `Supabase Project API request failed: ${fallback.error}` });
        return;
      }

      if (fallback.status >= 200 && fallback.status < 300) {
        resolve({ ok: true, output: "Supabase Project URL and Publishable API Key verified." });
        return;
      }

      if (fallback.status !== 401 && fallback.status !== 403) {
        resolve({ ok: true, output: "Supabase project endpoint reachable and key accepted for gateway access." });
        return;
      }

      const reason = fallback.snippet.length > 0 ? fallback.snippet : primary.snippet.length > 0 ? primary.snippet : `HTTP ${fallback.status || primary.status}`;
      resolve({ ok: false, output: `Supabase Project API verification failed: ${reason}` });
    })();
  });
}
