import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function resolveLocalBin(repoRoot: string, name: string): string {
  const executable = process.platform === 'win32' ? `${name}.cmd` : name;
  return join(repoRoot, 'node_modules', '.bin', executable);
}

export function execLocalBin(
  repoRoot: string,
  name: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string {
  const executable = resolveLocalBin(repoRoot, name);
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', executable, ...args], {
      ...options,
    });
  }
  return execFileSync(executable, args, options);
}

export function prependPathEntry(entry: string, existingPath = process.env.PATH ?? ''): string {
  return existingPath ? `${entry}${delimiter}${existingPath}` : entry;
}

export function writeCommandStub(binDir: string, name: string, body: string): string {
  if (process.platform === 'win32') {
    const scriptPath = join(binDir, `${name}.js`);
    const shimPath = join(binDir, `${name}.cmd`);
    writeFileSync(scriptPath, body, 'utf8');
    writeFileSync(shimPath, `@echo off\r\nnode "%~dp0\\${name}.js" %*\r\n`, 'utf8');
    return scriptPath;
  }

  const executablePath = join(binDir, name);
  writeFileSync(executablePath, body, 'utf8');
  chmodSync(executablePath, 0o755);
  return executablePath;
}

export function normalizeSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

export function pathListIncludesSuffix(paths: string[], suffix: string): boolean {
  const normalizedSuffix = normalizeSlashes(suffix);
  return paths.some((value) => {
    const normalized = normalizeSlashes(value);
    return normalized === normalizedSuffix || normalized.endsWith(`/${normalizedSuffix}`);
  });
}
