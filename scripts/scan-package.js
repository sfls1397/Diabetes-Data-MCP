#!/usr/bin/env node
/** Scan exactly the files npm will publish, without lifecycle scripts or private output. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diabetes-package-scan-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  const pack = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  for (const { path: relative } of pack.files) {
    const source = path.resolve(root, relative);
    if (!source.startsWith(root + path.sep)) throw new Error('Unsafe package file path');
    const target = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const docker = process.argv.includes('--docker') || process.env.CI === 'true';
  const command = docker ? 'docker' : 'gitleaks';
  const args = docker
    ? ['run', '--rm', '-v', `${temporary}:/package:ro`, '-v', `${path.join(root, '.gitleaks.toml')}:/config.toml:ro`, 'ghcr.io/gitleaks/gitleaks:v8.30.1', 'dir', '--config', '/config.toml', '--redact=100', '--no-banner', '/package']
    : ['dir', '--config', path.join(root, '.gitleaks.toml'), '--redact=100', '--no-banner', temporary];
  execFileSync(command, args, { stdio: 'ignore' });
  console.log(`Package privacy/secret scan PASS (${pack.files.length} files).`);
} catch {
  console.error('Package privacy/secret scan failed or could not complete. Install Gitleaks and inspect locally with redaction enabled.');
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
