import * as vscode from "vscode";
import { Manifold } from "./manifold";

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function parseSetupProjectName(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^setup(?:\s+([a-zA-Z0-9-_]+))?/i);
  return match?.[1];
}

function parseDeployProjectName(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^deploy(?:\s+([a-zA-Z0-9-_]+))?/i);
  return match?.[1];
}

function toPlainText(markdown: string): string {
  return markdown
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

function createOutputStream(output: vscode.OutputChannel): {
  markdown: (message: string) => void;
  button: (button: { title: string; command?: string; arguments?: unknown[] }) => void;
} {
  return {
    markdown: (message: string) => {
      output.appendLine(toPlainText(message));
    },
    button: (button) => {
      const commandInfo = button.command ? ` -> ${button.command}` : "";
      output.appendLine(`[Action] ${button.title}${commandInfo}`);
    }
  };
}

function getWindowsInstallCommand(tool: string): string | null {
  const map: Record<string, string> = {
    git: "winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements",
    node: "winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements",
    python: "winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements",
    gh: "winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements",
    vercel: "npm install -g vercel"
  };

  return map[tool] ?? null;
}

export function activate(context: vscode.ExtensionContext): void {
  const elevatedInstallDisposable = vscode.commands.registerCommand("manifold.runElevatedInstall", async (tool: string) => {
    if (process.platform !== "win32") {
      await vscode.window.showWarningMessage("Elevated install shortcut is currently implemented for Windows only.");
      return;
    }

    const installCommand = getWindowsInstallCommand(tool);
    if (!installCommand) {
      await vscode.window.showWarningMessage(`No install command is defined for ${tool}.`);
      return;
    }

    const escaped = installCommand.replace(/'/g, "''");
    const elevation = `Start-Process PowerShell -Verb RunAs -ArgumentList '-NoExit','-Command','${escaped}'`;

    const terminal = vscode.window.createTerminal({ name: "Manifold (Elevation)" });
    terminal.show(true);
    terminal.sendText(elevation, true);
    await vscode.window.showInformationMessage(`Requested elevated install for ${tool}. Approve the UAC prompt to continue.`);
  });

  const resetDisposable = vscode.commands.registerCommand("manifold.reset", async () => {
    const folder = getPrimaryWorkspaceFolder();
    if (!folder) {
      await vscode.window.showWarningMessage("Open a workspace folder before using Manifold.");
      return;
    }

    const manifold = Manifold.fromWorkspace(folder, context.globalStorageUri.fsPath, context.secrets);
    await manifold.resetState();
    await vscode.window.showInformationMessage("Manifold state reset (.manifold.json removed).");
  });

  const setupDisposable = vscode.commands.registerCommand("manifold.setup", async () => {
    const folder = getPrimaryWorkspaceFolder();
    if (!folder) {
      await vscode.window.showWarningMessage("Open a workspace folder before using Manifold.");
      return;
    }

    const projectName = await vscode.window.showInputBox({
      title: "Manifold Setup",
      prompt: "Project name",
      placeHolder: "my-cool-app"
    });

    if (!projectName) {
      return;
    }

    const manifold = Manifold.fromWorkspace(folder, context.globalStorageUri.fsPath, context.secrets);
    const output = vscode.window.createOutputChannel("Manifold");
    output.show(true);
    output.appendLine(`Starting setup for ${projectName}`);

    await manifold.handleSetup(projectName, createOutputStream(output));
  });

  const deployDisposable = vscode.commands.registerCommand("manifold.deploy", async () => {
    const folder = getPrimaryWorkspaceFolder();
    if (!folder) {
      await vscode.window.showWarningMessage("Open a workspace folder before using Manifold.");
      return;
    }

    const manifold = Manifold.fromWorkspace(folder, context.globalStorageUri.fsPath, context.secrets);
    const output = vscode.window.createOutputChannel("Manifold");
    output.show(true);
    output.appendLine("Starting Manifold deploy");

    await manifold.handleDeploy(undefined, createOutputStream(output));
  });

  context.subscriptions.push(elevatedInstallDisposable, resetDisposable, setupDisposable, deployDisposable);

  const vscodeAny = vscode as any;
  if (vscodeAny.chat?.createChatParticipant) {
    const participant = vscodeAny.chat.createChatParticipant("manifold.manifold", async (request: any, _context: any, stream: any) => {
      const folder = getPrimaryWorkspaceFolder();
      if (!folder) {
        stream.markdown("Open a workspace folder before running Manifold.");
        return;
      }

      const manifold = Manifold.fromWorkspace(folder, context.globalStorageUri.fsPath, context.secrets);
      const prompt = String(request?.prompt ?? "");
      const projectName = parseSetupProjectName(prompt);
      const deployProjectName = parseDeployProjectName(prompt);

      if (/^setup/i.test(prompt.trim())) {
        await manifold.handleSetup(projectName, stream);
        return;
      }

      if (/^deploy/i.test(prompt.trim())) {
        await manifold.handleDeploy(deployProjectName, stream);
        return;
      }

      stream.markdown("Manifold is active. Try: `@manifold setup my-cool-app` or `@manifold deploy`.");
    });

    context.subscriptions.push(participant);
  }
}

export function deactivate(): void {
}
