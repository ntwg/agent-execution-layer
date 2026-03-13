import type { RuntimePlatform } from './config.js';

export interface CommandInvocation {
  command: string;
  args: string[];
}

export interface CommandRuntimeProfile {
  key: Exclude<RuntimePlatform, 'auto'>;
  shellCommands: ReadonlySet<string>;
  wrapCommand(args: string[]): CommandInvocation;
  wrapOverrideCommand?(override: string, args: string[]): CommandInvocation;
}

const WINDOWS_SHELL_COMMANDS = new Set(['az', 'git', 'curl']);

function escapeWindowsShellArg(arg: string): string {
  return arg.replaceAll(/[()%!^&|]/g, (match) => (match === '%' ? '%%' : `^${match}`));
}

function wrapPassthroughCommand(args: string[]): CommandInvocation {
  return {
    command: args[0] ?? '',
    args: args.slice(1),
  };
}

function wrapWindowsShellCommand(args: string[]): CommandInvocation {
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', ...args.map(escapeWindowsShellArg)],
  };
}

const WINDOWS_COMMAND_PROFILE: CommandRuntimeProfile = {
  key: 'windows',
  shellCommands: WINDOWS_SHELL_COMMANDS,
  wrapCommand: wrapWindowsShellCommand,
  wrapOverrideCommand: (override, args) => ({
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', override, ...args.slice(1).map(escapeWindowsShellArg)],
  }),
};

const MAC_COMMAND_PROFILE: CommandRuntimeProfile = {
  key: 'mac',
  shellCommands: new Set(),
  wrapCommand: wrapPassthroughCommand,
};

const LINUX_COMMAND_PROFILE: CommandRuntimeProfile = {
  key: 'linux',
  shellCommands: new Set(),
  wrapCommand: wrapPassthroughCommand,
};

export function normalizeConfiguredRuntimePlatform(
  value: string | RuntimePlatform | undefined,
): RuntimePlatform {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'windows' || normalized === 'mac' || normalized === 'linux') {
    return normalized;
  }
  return 'auto';
}

export function resolveConfiguredExecutionPlatform(
  value: string | RuntimePlatform | undefined,
  fallbackPlatform: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  const configured = normalizeConfiguredRuntimePlatform(value);
  if (configured === 'windows') return 'win32';
  if (configured === 'mac') return 'darwin';
  if (configured === 'linux') return 'linux';
  return fallbackPlatform;
}

export function resolveCommandRuntimeProfile(
  platform: NodeJS.Platform | string = process.platform,
): CommandRuntimeProfile {
  if (platform === 'win32') return WINDOWS_COMMAND_PROFILE;
  if (platform === 'darwin') return MAC_COMMAND_PROFILE;
  return LINUX_COMMAND_PROFILE;
}

function resolveCommandOverride(
  args: string[],
  platform: NodeJS.Platform | string,
  env: NodeJS.ProcessEnv,
  profile: CommandRuntimeProfile,
): CommandInvocation | undefined {
  const rawCommand = args[0]?.trim();
  if (!rawCommand) return undefined;

  const override = env[`AEL_CMD_${rawCommand.toUpperCase()}`]?.trim();
  if (!override) return undefined;

  if (/\.(?:[cm]?js)$/i.test(override)) {
    return {
      command: process.execPath,
      args: [override, ...args.slice(1)],
    };
  }

  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(override) && profile.wrapOverrideCommand) {
    return profile.wrapOverrideCommand(override, args);
  }

  return {
    command: override,
    args: args.slice(1),
  };
}

export function resolveCommandInvocation(
  args: string[],
  platform: NodeJS.Platform | string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CommandInvocation {
  const profile = resolveCommandRuntimeProfile(platform);
  const override = resolveCommandOverride(args, platform, env, profile);
  if (override) {
    return override;
  }

  const rawCommand = args[0]?.trim().toLowerCase() ?? '';
  if (profile.shellCommands.has(rawCommand)) {
    return profile.wrapCommand(args);
  }

  return {
    command: args[0] ?? '',
    args: args.slice(1),
  };
}
