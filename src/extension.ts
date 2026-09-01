import * as vscode from 'vscode';

// Matches Claude Code's interactive confirmation prompts, e.g.:
//   Do you want to proceed?
//   ❯ 1. Yes
//     2. No
// The "❯ 1. Yes" pattern also covers edit/create/bash approval variants
// that don't share the exact "Do you want to proceed?" wording.
const PROMPT_PATTERNS: RegExp[] = [/do you want to (proceed|make this edit|create)/i, /❯\s*1\.\s*yes/i];

const DEBOUNCE_MS = 2000;
const BUFFER_MAX = 4000;

let statusBarItem: vscode.StatusBarItem;
let output: vscode.OutputChannel;
const armedTerminals = new Set<vscode.Terminal>();
const lastSentAt = new WeakMap<vscode.Terminal, number>();

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

function updateStatusBar(): void {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    statusBarItem.text = '$(circle-slash) Auto-Accept';
    statusBarItem.tooltip = 'No active terminal';
    statusBarItem.backgroundColor = undefined;
    return;
  }

  const armed = armedTerminals.has(terminal);
  statusBarItem.text = armed ? '$(zap) Auto-Accept: ON' : '$(circle-large-outline) Auto-Accept: OFF';
  statusBarItem.tooltip = armed
    ? `Auto-accepting Claude Code prompts in "${terminal.name}". Click to disarm.`
    : `Click to auto-accept Claude Code prompts in "${terminal.name}".`;
  statusBarItem.backgroundColor = armed ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

function toggleActiveTerminal(): void {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('Claude Code Auto-Accept: no active terminal to arm.');
    return;
  }

  if (armedTerminals.has(terminal)) {
    armedTerminals.delete(terminal);
  } else {
    armedTerminals.add(terminal);
  }
  updateStatusBar();
}

async function watchExecution(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): Promise<void> {
  const commandLine = execution.commandLine?.value ?? '(unknown command)';
  output.appendLine(`[${terminal.name}] execution started: ${commandLine}`);
  let buffer = '';
  try {
    for await (const chunk of execution.read()) {
      buffer = stripAnsi(buffer + chunk).slice(-BUFFER_MAX);
      if (PROMPT_PATTERNS.some((re) => re.test(buffer))) {
        if (!armedTerminals.has(terminal)) {
          output.appendLine(`[${terminal.name}] prompt detected but terminal is not armed, ignoring`);
          buffer = '';
          continue;
        }
        const now = Date.now();
        const last = lastSentAt.get(terminal) ?? 0;
        if (now - last > DEBOUNCE_MS) {
          lastSentAt.set(terminal, now);
          output.appendLine(`[${terminal.name}] prompt detected, sending Enter`);
          terminal.sendText('', true);
        }
        buffer = '';
      }
    }
    output.appendLine(`[${terminal.name}] execution ended: ${commandLine}`);
  } catch (err) {
    output.appendLine(`[${terminal.name}] execution.read() errored: ${err}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Claude Code Auto-Accept');
  context.subscriptions.push(output);
  output.appendLine('Claude Code Auto-Accept activated');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeAutoAccept.toggle';
  updateStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(vscode.commands.registerCommand('claudeAutoAccept.toggle', toggleActiveTerminal));
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(updateStatusBar));
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      armedTerminals.delete(terminal);
      updateStatusBar();
    })
  );

  if (vscode.window.onDidStartTerminalShellExecution) {
    // Watch every execution regardless of current armed state - a terminal is often
    // armed after `claude` has already started, and arming state is checked at
    // prompt-detection time inside watchExecution, not here.
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        void watchExecution(e.terminal, e.execution);
      })
    );
  } else {
    vscode.window.showWarningMessage(
      'Claude Code Auto-Accept: this VS Code version lacks the Terminal Shell Integration API, so prompts cannot be detected.'
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeTerminalShellIntegration((e) => {
      output.appendLine(`[${e.terminal.name}] shell integration became available`);
    })
  );
}

export function deactivate(): void {}
