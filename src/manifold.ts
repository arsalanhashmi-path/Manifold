import * as vscode from "vscode";
import * as path from "node:path";
import { installMissingTool, runEnvironmentChecks, ToolKey } from "./start";
import { BackendStack, StateManager } from "./state";
import { runInManifoldTerminal } from "./utils/terminal";
import { scaffoldReactSupabaseProject } from "./scaffold";
import { runProvisioning } from "./provision";
import { wireProjectEnvironment } from "./env";
import { runDeployment } from "./deploy";
import {
  checkGhAuthStatus,
  checkVercelWhoAmI,
  parseSupabaseProjectRef,
  verifySupabasePat,
  verifySupabaseProjectApi
} from "./auth";

export class Manifold {
  private readonly supabasePatSecretKey = "manifold.supabase.pat";
  private readonly supabaseProjectUrlSecretKey = "manifold.supabase.projectUrl";
  private readonly supabasePublishableKeySecretKey = "manifold.supabase.publishableKey";
  private readonly supabaseAccessTokenSecretKey = "manifold.supabase.accessToken";
  private readonly vercelTokenSecretKey = "manifold.vercel.token";

  constructor(
    private readonly workspaceRoot: string,
    private readonly stateManager: StateManager,
    private readonly globalStoragePath: string,
    private readonly secrets: vscode.SecretStorage
  ) {}

  async handleSetup(projectName: string | undefined, stream: any): Promise<void> {
    const selectedName = projectName?.trim() || "my-app";
    await this.stateManager.ensureInitialized(selectedName, "flask");
    await this.stateManager.patch({
      status: "in_progress",
      current_phase: "0_env_check",
      config: {
        project_name: selectedName,
        stack: {
          frontend: "react-vite",
          backend: "flask"
        }
      }
    });

    stream.markdown(`## Manifold Setup\nInitializing setup for **${selectedName}**.\n\n`);
    await this.bootstrap(stream);
  }

  async bootstrap(stream: any): Promise<void> {
    stream.markdown("### Phase 0 · Environment Check\nValidating prerequisites (`git`, `node`, `gh`, `vercel`, `supabase`)\n\n");
    let report = await runEnvironmentChecks();

    const versionLines = report.tools.map((tool) => {
      if (tool.ok) {
        const detected = tool.output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "detected";
        return `- **${tool.tool}**: ✅ ${detected}`;
      }

      return `- **${tool.tool}**: ❌ not found`;
    });
    stream.markdown(`**Detected tools**\n${versionLines.join("\n")}\n\n`);

    let missing = report.tools.filter((item) => !item.ok);
    if (missing.length === 0) {
      stream.markdown("✅ All required tools are installed.\n\n");
      await this.stateManager.patch({ current_phase: "1_auth", status: "in_progress" });
      stream.markdown("Phase 0 complete. Moving to authentication.\n\n");
      await this.runAuthHandshake(stream);
      return;
    }

    const lines = missing.map((tool) => `- **${tool.tool}** missing. Install with: \`${tool.installHint}\``);
    stream.markdown(`**Missing tools on ${report.platform}**\n${lines.join("\n")}\n\n`);

    stream.markdown("Attempting automatic installation...\n\n");
    const installOrder: ToolKey[] = ["git", "node", "python", "gh", "vercel", "supabase"];
    const missingOrder = missing
      .map((item) => item.tool)
      .sort((a, b) => installOrder.indexOf(a) - installOrder.indexOf(b));

    for (const tool of missingOrder) {
      stream.markdown(`Installing **${tool}**\n`);
      const attempt = await installMissingTool(tool, report.platform, {
        globalStoragePath: this.globalStoragePath,
        onCommand: (command) => runInManifoldTerminal(command)
      });

      if (attempt.pathAddition) {
        const currentPath = process.env.PATH ?? "";
        process.env.PATH = `${attempt.pathAddition}${path.delimiter}${currentPath}`;
      }

      if (attempt.ok) {
        const methodLabel = attempt.method === "fallback" ? " (local fallback)" : "";
        stream.markdown(`- ✅ **${tool}** installed${methodLabel}.\n`);
      } else if (attempt.attempted) {
        stream.markdown(`- ⚠️ **${tool}** auto-install failed.\n`);
      } else {
        stream.markdown(`- ⚠️ **${tool}** requires manual install on this OS.\n`);
      }
    }

    stream.markdown("\nRe-checking environment after install attempts\n\n");
    report = await runEnvironmentChecks();
    const postInstallLines = report.tools.map((tool) => {
      if (tool.ok) {
        const detected = tool.output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "detected";
        return `- **${tool.tool}**: ✅ ${detected}`;
      }

      return `- **${tool.tool}**: ❌ not found`;
    });
    stream.markdown(`**Post-install status**\n${postInstallLines.join("\n")}\n\n`);
    missing = report.tools.filter((item) => !item.ok);

    if (missing.length === 0) {
      await this.stateManager.patch({ current_phase: "1_auth", status: "in_progress" });
      stream.markdown("✅ All prerequisites are now installed. Phase 0 complete.\n\n");
      await this.runAuthHandshake(stream);
      return;
    }

    const retryLines = missing.map((tool) => `- **${tool.tool}** still missing. Try: \`${tool.installHint}\``);
    stream.markdown(`**Manual action required**\n${retryLines.join("\n")}\n\n`);

    if (report.platform === "win32") {
      stream.markdown("Run elevated install for the remaining tools:\n");
      for (const tool of missing) {
        const args = encodeURIComponent(JSON.stringify([tool.tool]));
        const commandUri = `command:manifold.runElevatedInstall?${args}`;
        stream.markdown(`- [Run elevated install for ${tool.tool}](${commandUri})\n`);

        if (typeof stream.button === "function") {
          stream.button({
            command: "manifold.runElevatedInstall",
            title: `Run elevated install: ${tool.tool}`,
            arguments: [tool.tool]
          });
        }
      }
      stream.markdown("\n");
    }

    await this.stateManager.patch({ status: "paused_at_auth", current_phase: "0_env_check" });
    stream.markdown("Auto-install could not complete all prerequisites. Install the remaining tools and run `@manifold setup <project-name>` again.\n");
  }

  async resetState(): Promise<void> {
    await this.stateManager.reset();
    await this.secrets.delete(this.supabasePatSecretKey);
    await this.secrets.delete(this.supabaseProjectUrlSecretKey);
    await this.secrets.delete(this.supabasePublishableKeySecretKey);
    await this.secrets.delete(this.supabaseAccessTokenSecretKey);
    await this.secrets.delete(this.vercelTokenSecretKey);
  }

  static fromWorkspace(folder: vscode.WorkspaceFolder, globalStoragePath: string, secrets: vscode.SecretStorage): Manifold {
    const stateManager = new StateManager(folder.uri.fsPath);
    return new Manifold(folder.uri.fsPath, stateManager, globalStoragePath, secrets);
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  setBackend(_backend: BackendStack): void {
  }

  private async runAuthHandshake(stream: any): Promise<void> {
    stream.markdown("### Phase 1 · Authentication\nVerifying `gh`, `vercel`, and Supabase credentials\n\n");

    const gh = await checkGhAuthStatus();
    const vercel = await checkVercelWhoAmI();

    let supabaseOk = false;
    let supabaseMode: "project_api" | null = null;
    const state = await this.stateManager.read();
    const existingAccessToken = state.credentials.supabase_access_token;
    const existingProjectUrl = state.credentials.supabase_url;
    const existingPublishableKey = state.credentials.supabase_publishable_key;

    if (!supabaseOk && existingAccessToken && existingProjectUrl && existingPublishableKey) {
      const verifyExistingProjectApi = await verifySupabaseProjectApi(existingProjectUrl, existingPublishableKey);
      supabaseOk = verifyExistingProjectApi.ok;
      if (verifyExistingProjectApi.ok) {
        supabaseMode = "project_api";
        const ref = parseSupabaseProjectRef(existingProjectUrl);
        if (ref) {
          await this.stateManager.patch({
            resources: {
              supabase_ref: ref
            }
          });
        }
      } else {
        await this.stateManager.patch({
          credentials: {
            supabase_access_token: null,
            supabase_url: null,
            supabase_publishable_key: null
          }
        });
      }
    }

    if (!supabaseOk) {
      stream.markdown("Collecting Supabase credentials\n\n");
      
      // Step 1: Supabase Access Token (for deployment)
      const accessToken = await vscode.window.showInputBox({
        title: "Manifold Auth Handshake - Supabase Access Token",
        prompt: "Enter your Supabase Access Token (for Edge Functions deployment)",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sbp_...",
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return "Access token is required";
          }
          return null;
        }
      });

      if (!accessToken || accessToken.trim().length === 0) {
        stream.markdown("- **supabase**: ❌ Access token is required. Setup cancelled.\n");
        supabaseOk = false;
      } else {
        // Step 2: Project URL
        const projectUrl = await vscode.window.showInputBox({
          title: "Manifold Auth Handshake - Project URL",
          prompt: "Enter your Supabase Project URL",
          ignoreFocusOut: true,
          placeHolder: "https://your-project-ref.supabase.co",
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return "Project URL is required";
            }
            if (!value.includes("supabase.co")) {
              return "Must be a valid Supabase project URL";
            }
            return null;
          }
        });

        if (!projectUrl || projectUrl.trim().length === 0) {
          stream.markdown("- **supabase**: ❌ Project URL is required. Setup cancelled.\n");
          supabaseOk = false;
        } else {
          // Step 3: Publishable API Key
          const publishableKey = await vscode.window.showInputBox({
            title: "Manifold Auth Handshake - Publishable API Key",
            prompt: "Enter your Supabase Publishable API Key",
            password: true,
            ignoreFocusOut: true,
            placeHolder: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return "Publishable API key is required";
              }
              return null;
            }
          });

          if (!publishableKey || publishableKey.trim().length === 0) {
            stream.markdown("- **supabase**: ❌ Publishable API key is required. Setup cancelled.\n");
            supabaseOk = false;
          } else {
            // Verify and store credentials
            const verification = await verifySupabaseProjectApi(projectUrl.trim(), publishableKey.trim());
            if (verification.ok) {
              const normalizedUrl = projectUrl.trim().replace(/\/+$/, "");
              const ref = parseSupabaseProjectRef(normalizedUrl);
              
              await this.stateManager.patch({
                resources: {
                  supabase_ref: ref
                },
                credentials: {
                  supabase_url: normalizedUrl,
                  supabase_publishable_key: publishableKey.trim(),
                  supabase_access_token: accessToken.trim()
                }
              });

              supabaseOk = true;
              supabaseMode = "project_api";
              stream.markdown("- **supabase**: ✅ credentials verified and stored\n");
            } else {
              stream.markdown(`- **supabase**: ❌ ${verification.output}\n`);
              supabaseOk = false;
            }
          }
        }
      }
    }

    const ghDetected = gh.output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "authentication check complete";
    const vercelDetected = vercel.output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "authentication check complete";

    stream.markdown("**Authentication status**\n");
    stream.markdown(`- **gh**: ${gh.ok ? "✅" : "❌"} ${ghDetected}\n`);
    stream.markdown(`- **vercel**: ${vercel.ok ? "✅" : "❌"} ${vercelDetected}\n`);
    const supabaseSummary = supabaseOk
      ? supabaseMode === "project_api"
        ? "✅ verified (Access Token + Project URL + Publishable API Key)"
        : "✅ verified"
      : "❌ not verified";
    stream.markdown(`- **supabase**: ${supabaseSummary}\n\n`);

    let vercelTokenOk = false;
    if (gh.ok && vercel.ok && supabaseOk) {
      stream.markdown("Collecting deployment credentials\n\n");
      const vercelToken = await vscode.window.showInputBox({
        title: "Manifold Auth Handshake",
        prompt: "Enter your Vercel API Token (for production deployment)",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "vercel_..."
      });

      if (vercelToken && vercelToken.trim().length > 0) {
        await this.stateManager.patch({
          credentials: {
            vercel_token: vercelToken.trim()
          }
        });
        vercelTokenOk = true;
        stream.markdown("- **vercel token**: ✅ stored\n\n");
      } else {
        stream.markdown("- **vercel token**: ⚠️ skipped (optional for now)\n\n");
        vercelTokenOk = true;
      }

      await this.stateManager.patch({ current_phase: "2_scaffold", status: "in_progress" });
      stream.markdown("✅ Phase 1 complete. Authentication successful.\n\n");
      await this.runLocalScaffolding(stream);
      return;
    }

    await this.stateManager.patch({ current_phase: "1_auth", status: "paused_at_auth" });
    if (!gh.ok) {
      stream.markdown("- Sign in to GitHub CLI with: `gh auth login`\n");
    }
    if (!vercel.ok) {
      stream.markdown("- Sign in to Vercel CLI with: `vercel login`\n");
    }
    if (!supabaseOk) {
      stream.markdown("- Re-run setup and provide valid Supabase credentials (Access Token, Project URL, and Publishable API Key).\n");
    }
    stream.markdown("\nAuthentication is incomplete. Resolve the items above and run `@manifold setup <project-name>` again.\n");
  }

  private async runLocalScaffolding(stream: any): Promise<void> {
    const state = await this.stateManager.read();
    const projectName = state.config.project_name;

    stream.markdown(`### Phase 2 · Scaffolding\nCreating local project for **${projectName}** (React + Supabase Edge Functions)\n\n`);

    const result = await scaffoldReactSupabaseProject(this.workspaceRoot, projectName);
    const createdCount = result.created.length;
    stream.markdown(`- Scaffold root: \`${result.root}\`\n`);
    stream.markdown(`- Files created: **${createdCount}**\n`);

    for (const install of result.installs) {
      stream.markdown(`- ${install.step}: ${install.ok ? "✅ success" : "⚠️ failed after retry"}\n`);
    }

    const failed = result.installs.filter((item) => !item.ok);
    if (failed.length > 0) {
      await this.stateManager.patch({ current_phase: "2_scaffold", status: "paused_at_auth" });
      stream.markdown("\n⚠️ Phase 2 partially complete. Some dependency installs failed after retry.\n");
      stream.markdown("Run the failed install commands manually in the scaffolded project, then continue setup.\n");
      return;
    }

    await this.stateManager.patch({ current_phase: "3_provision", status: "in_progress" });
    stream.markdown("\n✅ Phase 2 complete. Local scaffold and dependencies are ready. Proceeding to provisioning.\n\n");
    await this.runProvisioningPhase(stream, result.root, projectName);
  }

  private async runProvisioningPhase(stream: any, projectRoot: string, projectName: string): Promise<void> {
    stream.markdown("### Phase 3 · Provisioning\nCreating cloud resources (GitHub + Vercel)\n\n");
    const result = await runProvisioning(projectRoot, projectName);

    for (const line of result.output) {
      stream.markdown(`- ${line}\n`);
    }

    if (!result.ok) {
      await this.stateManager.patch({
        current_phase: "3_provision",
        status: "failed",
        rollback_stack: []
      });
      stream.markdown("\n❌ Phase 3 failed. Rollback commands were applied where possible.\n");
      return;
    }

    await this.stateManager.patch({
      current_phase: "4_env_wiring",
      status: "in_progress",
      resources: {
        github_repo: result.githubRepo,
        vercel_project_id: result.vercelProjectId
      },
      rollback_stack: result.rollbackStack
    });

    stream.markdown("\n✅ Phase 3 complete. GitHub and Vercel resources are provisioned.\n\n");
    await this.runEnvWiringPhase(stream, projectRoot);
  }

  private async runEnvWiringPhase(stream: any, projectRoot: string): Promise<void> {
    stream.markdown("### Phase 4 · Environment Wiring\nConfiguring local environment variables\n\n");

    const state = await this.stateManager.read();
    const githubRepo = state.resources.github_repo;
    const vercelProjectId = state.resources.vercel_project_id;
    const supabaseUrl = state.credentials.supabase_url;
    const supabasePublishableKey = state.credentials.supabase_publishable_key;

    const missing: string[] = [];
    if (!githubRepo) missing.push("GitHub repo");
    if (!vercelProjectId) missing.push("Vercel project ID");
    if (!supabaseUrl) missing.push("Supabase URL");
    if (!supabasePublishableKey) missing.push("Supabase publishable key");

    if (missing.length > 0) {
      stream.markdown("⚠️ Phase 4 found missing values from a previous incomplete setup:\n");
      for (const item of missing) {
        stream.markdown(`- ${item}\n`);
      }
      stream.markdown("\nResetting to Phase 1 to collect credentials again\n\n");
      
      // Clear old secrets from VS Code storage
      await this.secrets.delete(this.supabasePatSecretKey);
      await this.secrets.delete(this.supabaseProjectUrlSecretKey);
      await this.secrets.delete(this.supabasePublishableKeySecretKey);
      await this.secrets.delete(this.supabaseAccessTokenSecretKey);
      
      // Reset to Phase 1 with clean state
      await this.stateManager.patch({ 
        current_phase: "1_auth", 
        status: "in_progress",
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
        }
      });
      
      await this.runAuthHandshake(stream);
      return;
    }

    // Type assertion: we've verified all values exist above
    const writes = await wireProjectEnvironment(projectRoot, {
      supabaseUrl: supabaseUrl!,
      supabasePublishableKey: supabasePublishableKey!,
      githubRepo: githubRepo!,
      vercelProjectId: vercelProjectId!
    });

    for (const write of writes) {
      stream.markdown(`- Updated \`${write.filePath}\` (${write.keys.length} keys)\n`);
    }

    await this.stateManager.patch({
      current_phase: "5_deploy",
      status: "in_progress"
    });

    stream.markdown("\n✅ Phase 4 complete. Environment variables are configured locally.\n\n");
    await this.runDeploymentPhase(stream, projectRoot);
  }

  private async runDeploymentPhase(stream: any, projectRoot: string): Promise<void> {
    stream.markdown("### Phase 5 · Deployment\nDeploying frontend (Vercel) and backend (Supabase Edge Functions)\n\n");
    const state = await this.stateManager.read();
    const vercelToken = state.credentials.vercel_token;
    const supabaseAccessToken = state.credentials.supabase_access_token;
    const supabaseRef = state.resources.supabase_ref;
    const deployResult = await runDeployment(
      projectRoot,
      vercelToken ?? undefined,
      supabaseAccessToken ?? undefined,
      supabaseRef ?? undefined
    );

    if (deployResult.errors.length > 0) {
      stream.markdown("**Detected deployment issues**\n\n");
      for (const err of deployResult.errors) {
        stream.markdown(`- **${err.type}**: ${err.line}\n`);
        stream.markdown(`  → ${err.suggestion}\n`);
      }
      stream.markdown("\n");
    }

    if (deployResult.logFilePath) {
      stream.markdown("**Deployment logs**\n\n");
      stream.markdown(`- Deploy: \`${deployResult.logFilePath}\`\n\n`);
    }

    if (deployResult.ok) {
      await this.stateManager.patch({
        current_phase: "5_deploy",
        status: "complete"
      });
      stream.markdown("✅ Phase 5 complete. Full-stack app is deployed and ready.\n");
      if (deployResult.frontendUrl) {
        stream.markdown(`\nFrontend URL: ${deployResult.frontendUrl}\n`);
      }
      if (deployResult.publicUrl) {
        stream.markdown(`Public link: ${deployResult.publicUrl}\n`);
      }
      if (deployResult.backendUrl) {
        stream.markdown(`Backend URL: ${deployResult.backendUrl}\n`);
      }
      stream.markdown("\n🎉 Manifold setup completed successfully. Your app is live.\n");
      return;
    }

    await this.stateManager.patch({
      current_phase: "5_deploy",
      status: "paused_at_auth"
    });
    stream.markdown("❌ Phase 5 encountered deployment issues. Review the logs and suggestions above.\n");
    stream.markdown("Fix the issues and re-run the deployment command manually, or run '@manifold setup <project-name>' again.\n");
  }
}
