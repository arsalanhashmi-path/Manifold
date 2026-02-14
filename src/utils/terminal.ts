import * as vscode from "vscode";

const TERMINAL_NAME = "Manifold";

export function getManifoldTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_NAME);
  if (existing) {
    return existing;
  }

  return vscode.window.createTerminal({ name: TERMINAL_NAME });
}

export function runInManifoldTerminal(command: string): void {
  const terminal = getManifoldTerminal();
  terminal.show(true);
  terminal.sendText(command, true);
}
