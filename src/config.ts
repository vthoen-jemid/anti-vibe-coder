import * as vscode from 'vscode';

export interface SignalConfig {
  enabled: boolean;
  weight: number;
}

export interface Config {
  baseBranch: string;
  viewport: SignalConfig;
  cursor: SignalConfig;
  selection: SignalConfig;
  hover: SignalConfig;
  typing: SignalConfig & { maxChars: number };
  idleTimeoutSeconds: number;
  reviewedThreshold: number;
  colorUnseen: string;
  colorSeen: string;
  hideWhenFullyReviewed: boolean;
  ignoreWhitespaceOnlyLines: boolean;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('antiVibe');
  return {
    baseBranch: c.get<string>('baseBranch', '').trim(),
    viewport: {
      enabled: c.get('signals.viewport.enabled', true),
      weight: c.get('signals.viewport.weight', 0.03),
    },
    cursor: {
      enabled: c.get('signals.cursor.enabled', true),
      weight: c.get('signals.cursor.weight', 0.2),
    },
    selection: {
      enabled: c.get('signals.selection.enabled', true),
      weight: c.get('signals.selection.weight', 0.1),
    },
    hover: {
      enabled: c.get('signals.hover.enabled', true),
      weight: c.get('signals.hover.weight', 0.15),
    },
    typing: {
      enabled: c.get('signals.typing.enabled', true),
      weight: c.get('signals.typing.weight', 0.25),
      maxChars: c.get('signals.typing.maxChars', 80),
    },
    idleTimeoutSeconds: c.get('idleTimeoutSeconds', 60),
    reviewedThreshold: c.get('reviewedThreshold', 0.8),
    colorUnseen: c.get('colors.unseen', 'rgba(40, 120, 255, 0.28)'),
    colorSeen: c.get('colors.seen', 'rgba(255, 70, 170, 0.22)'),
    hideWhenFullyReviewed: c.get('hideWhenFullyReviewed', false),
    ignoreWhitespaceOnlyLines: c.get('ignoreWhitespaceOnlyLines', true),
  };
}
