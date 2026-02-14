import * as fs from "node:fs/promises";
import * as path from "node:path";

export type RunStatus = "in_progress" | "complete" | "failed" | "paused_at_auth";
export type BackendStack = "flask" | "fastapi" | "django";

export interface ManifoldState {
  status: RunStatus;
  state_version: number;
  run_id: string;
  current_phase: string;
  config: {
    project_name: string;
    stack: {
      frontend: "react-vite";
      backend: BackendStack;
    };
  };
  resources: {
    github_repo: string | null;
    vercel_project_id: string | null;
    supabase_ref: string | null;
  };
  credentials: {
    vercel_token: string | null;
    supabase_access_token: string | null;
    supabase_url: string | null;
    supabase_publishable_key: string | null;
  };
  rollback_stack: string[];
}

type ManifoldStatePatch = Omit<Partial<ManifoldState>, "config" | "resources" | "credentials"> & {
  config?: Partial<ManifoldState["config"]> & {
    stack?: Partial<ManifoldState["config"]["stack"]>;
  };
  resources?: Partial<ManifoldState["resources"]>;
  credentials?: Partial<ManifoldState["credentials"]>;
};

const STATE_FILE = ".manifold.json";

export function createDefaultState(projectName = "my-app", backend: BackendStack = "flask"): ManifoldState {
  return {
    status: "in_progress",
    state_version: 1,
    run_id: `${Date.now()}`,
    current_phase: "0_env_check",
    config: {
      project_name: projectName,
      stack: {
        frontend: "react-vite",
        backend
      }
    },
    resources: {
      github_repo: null,
      vercel_project_id: null,
      supabase_ref: null
    },
    credentials: {
      vercel_token: null,
      supabase_access_token: null,
      supabase_url: null,
      supabase_publishable_key: null
    },
    rollback_stack: []
  };
}

export class StateManager {
  private readonly filePath: string;

  constructor(private readonly workspaceRoot: string) {
    this.filePath = path.join(workspaceRoot, STATE_FILE);
  }

  async ensureInitialized(projectName?: string, backend: BackendStack = "flask"): Promise<ManifoldState> {
    try {
      const state = await this.read();
      return state;
    } catch {
      const fresh = createDefaultState(projectName ?? "my-app", backend);
      await this.writeAtomic(fresh);
      return fresh;
    }
  }

  async read(): Promise<ManifoldState> {
    const raw = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(raw) as ManifoldState;
  }

  async write(state: ManifoldState): Promise<void> {
    await this.writeAtomic(state);
  }

  async patch(patch: ManifoldStatePatch): Promise<ManifoldState> {
    const current = await this.read();
    const next: ManifoldState = {
      ...current,
      ...patch,
      config: {
        ...current.config,
        ...(patch.config ?? {}),
        stack: {
          ...current.config.stack,
          ...(patch.config?.stack ?? {})
        }
      },
      resources: {
        ...current.resources,
        ...(patch.resources ?? {})
      },
      credentials: {
        ...current.credentials,
        ...(patch.credentials ?? {})
      },
      rollback_stack: patch.rollback_stack ?? current.rollback_stack
    };
    await this.writeAtomic(next);
    return next;
  }

  async reset(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }

  private async writeAtomic(state: ManifoldState): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, this.filePath);
  }
}
