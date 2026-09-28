import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export async function discoverTests(root, scope = 'core') {
  if (!['core', 'dashboard', 'all'].includes(scope)) throw new Error(`Invalid test scope: ${scope}`);
  const tests = [];
  async function visit(directory, dashboard = false) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['support', 'fixtures', 'browser'].includes(entry.name)) {
          await visit(path, dashboard || entry.name === 'dashboard');
        }
      } else if (entry.isFile() && entry.name.endsWith('.test.ts') &&
        (scope === 'all' || dashboard === (scope === 'dashboard'))) {
        tests.push(path);
      }
    }
  }
  await visit(resolve(root));
  return tests.sort();
}

async function main(args) {
  let scope = 'core';
  if (args[0] && !args[0].startsWith('-')) scope = args.shift();
  const files = await discoverTests(fileURLToPath(new URL('../tests/', import.meta.url)), scope);
  if (!files.length) throw new Error(`No tests discovered for scope: ${scope}`);
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...args, ...files], { stdio: 'inherit' });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  }));
  const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
  child.once('error', error => { cleanup(); console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
