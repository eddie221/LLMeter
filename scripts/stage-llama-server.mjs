#!/usr/bin/env node

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
const platform = platformMap[process.platform] ?? process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch;
const target = `${platform}-${arch}`;
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const outDir = join(repoRoot, 'src-tauri', 'resources', 'llama', target);
const binDir = join(outDir, 'bin');
const libDir = join(outDir, 'lib');
const executableName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const userSource = process.argv[2] || process.env.LLAMA_SERVER_PATH;

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function findSource() {
  if (userSource) return realpathSync(userSource);
  try {
    const found = commandOutput(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? ['llama-server.exe'] : ['-v', 'llama-server']);
    return realpathSync(found.split(/\r?\n/)[0]);
  } catch {
    for (const candidate of ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server', '/usr/bin/llama-server']) {
      if (existsSync(candidate)) return realpathSync(candidate);
    }
  }
  throw new Error('Unable to find llama-server. Pass a path: npm run bundle:llama -- /path/to/llama-server');
}

function parseDylibs(file) {
  const output = commandOutput('otool', ['-L', file]);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean)
    .filter(dep => !dep.startsWith('/System/') && !dep.startsWith('/usr/lib/'));
}

function resolveDylib(dep, loaderPath, searchDirs) {
  if (dep.startsWith('@rpath/')) {
    const name = dep.slice('@rpath/'.length);
    for (const dir of searchDirs) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
    return null;
  }
  if (dep.startsWith('@loader_path/')) {
    const candidate = resolve(loaderPath, dep.slice('@loader_path/'.length));
    return existsSync(candidate) ? realpathSync(candidate) : null;
  }
  return existsSync(dep) ? realpathSync(dep) : null;
}

function installName(file, args) {
  execFileSync('install_name_tool', args.concat(file), { stdio: 'inherit' });
}

function stageMac(source) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });

  const stagedExe = join(binDir, executableName);
  copyFileSync(source, stagedExe);

  const sourceBinDir = dirname(source);
  const sourceRoot = resolve(sourceBinDir, '..');
  const searchDirs = [
    join(sourceRoot, 'lib'),
    '/opt/homebrew/opt/llama.cpp/lib',
    '/usr/local/opt/llama.cpp/lib',
    '/opt/homebrew/opt/ggml/lib',
    '/usr/local/opt/ggml/lib',
    '/opt/homebrew/opt/openssl@3/lib',
    '/usr/local/opt/openssl@3/lib',
  ];
  const copied = new Map();
  const queue = [source];

  while (queue.length > 0) {
    const current = queue.shift();
    const loaderPath = dirname(current);
    for (const dep of parseDylibs(current)) {
      const resolved = resolveDylib(dep, loaderPath, searchDirs);
      if (!resolved || copied.has(resolved)) continue;
      const destination = join(libDir, basename(resolved));
      copyFileSync(resolved, destination);
      copied.set(resolved, destination);
      queue.push(resolved);
    }
  }

  // Add compatibility symlinks/copies for install names such as libllama.0.dylib.
  for (const [resolved, destination] of Array.from(copied.entries())) {
    const dir = dirname(resolved);
    for (const dep of parseDylibs(destination)) {
      const linked = resolveDylib(dep, dir, [dir, ...searchDirs]);
      if (linked && copied.has(linked)) {
        const depName = basename(dep);
        const compatPath = join(libDir, depName);
        if (!existsSync(compatPath)) copyFileSync(copied.get(linked), compatPath);
      }
    }
  }

  const filesToPatch = [stagedExe, ...readdirSync(libDir).filter(name => name.endsWith('.dylib')).map(name => join(libDir, name))]
    .filter(file => existsSync(file) && statSync(file).isFile());

  for (const file of filesToPatch) {
    try {
      installName(file, ['-add_rpath', '@loader_path/../lib']);
    } catch {
      // The rpath may already exist.
    }
    for (const dep of parseDylibs(file)) {
      const depName = basename(dep);
      const localDep = join(libDir, depName);
      if (existsSync(localDep)) installName(file, ['-change', dep, `@rpath/${depName}`]);
    }
    if (file !== stagedExe && basename(file).endsWith('.dylib')) {
      installName(file, ['-id', `@rpath/${basename(file)}`]);
    }
  }

  chmodSync(stagedExe, 0o755);
  for (const file of readdirSync(libDir).filter(name => name.endsWith('.dylib')).map(name => join(libDir, name))) {
    chmodSync(file, 0o644);
  }
  try {
    execFileSync('xattr', ['-cr', outDir], { stdio: 'ignore' });
  } catch {
    // xattr is macOS-specific and only needed to remove local provenance metadata.
  }
  const archive = join(dirname(outDir), `${target}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', dirname(outDir), target], { stdio: 'inherit' });

  console.log(`Staged llama-server for ${target}: ${stagedExe}`);
  console.log(`Created Tauri resource archive: ${archive}`);
  console.log(`Staged ${copied.size} dynamic libraries in ${libDir}`);
}

function stagePortable(source) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(binDir, { recursive: true });
  cpSync(source, join(binDir, executableName), { recursive: true });
  console.log(`Staged llama-server for ${target}: ${join(binDir, executableName)}`);
  console.warn('Note: non-macOS dependency bundling is not automated yet. Prefer a static llama-server build.');
}

const source = findSource();
if (!existsSync(source)) throw new Error(`llama-server not found: ${source}`);
if (process.platform === 'darwin') stageMac(source);
else stagePortable(source);
