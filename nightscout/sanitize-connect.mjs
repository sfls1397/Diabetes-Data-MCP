#!/usr/bin/env node
// Connector diagnostics include credentials/session payloads. Disable its verbose
// data dumps and emit only generic warning/error indicators in this deployment.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] || '.');
const connector = path.join(root, 'node_modules/nightscout-connect');
const manifest = JSON.parse(fs.readFileSync(path.join(connector, 'package.json'), 'utf8'));
if (manifest.version !== '0.0.13') throw new Error('Unreviewed connector version');
const sources = JSON.parse(fs.readFileSync(path.join(here, 'runtime-profile/connect-sources.json'), 'utf8'));
function prefix(target) {
  const helper = path.relative(path.dirname(target), path.join(connector, 'diabetes-safe-console.js')).split(path.sep).join('/');
  return `const console = require(${JSON.stringify(helper.startsWith('.') ? helper : './' + helper)});\n`;
}
const pending = [];
for (const [name, expected] of Object.entries(sources)) {
  const target = path.join(connector, name);
  const content = fs.readFileSync(target);
  if (createHash('sha256').update(content).digest('hex') !== expected) {
    const header = Buffer.from(prefix(target));
    if (!content.subarray(0, header.length).equals(header) ||
        createHash('sha256').update(content.subarray(header.length)).digest('hex') !== expected) {
      throw new Error('Connector logging source mismatch');
    }
  } else {
    pending.push(target);
  }
}
for (const target of pending) {
  fs.writeFileSync(target, prefix(target) + fs.readFileSync(target, 'utf8'));
}
fs.copyFileSync(path.join(here, 'compat/safe-console.cjs'), path.join(connector, 'diabetes-safe-console.js'));
console.log('Nightscout connector logging hardened (no credentials or data dumps)');
