#!/usr/bin/env node
// Apply the reviewed runtime profile only to the exact upstream source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] || '.');
const profile = path.join(here, 'runtime-profile');
const upstream = JSON.parse(fs.readFileSync(path.join(profile, 'upstream.json'), 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
if (head !== upstream.commit) throw new Error('Nightscout upstream commit mismatch');
for (const [name, expected] of Object.entries(upstream.files)) {
  const bytes = fs.readFileSync(path.join(target, name));
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('Nightscout upstream source mismatch');
  }
}

const changes = {
  'lib/api/entries/index.js': [
    "const braces = require('braces');\nconst expand = braces.expand;",
    "const expand = require('../shared/expand-pattern');"
  ],
  'lib/server/loop.js': ["require('@parse/node-apn')", "require('./apn-token')"],
  'tests/loop-server.test.js': ["require('@parse/node-apn')", "require('../lib/server/apn-token')"]
};
for (const [name, [before, after]] of Object.entries(changes)) {
  const file = path.join(target, name);
  const source = fs.readFileSync(file, 'utf8');
  if (source.split(before).length !== 2) throw new Error('Nightscout patch does not match exactly once');
  fs.writeFileSync(file, source.replace(before, after));
}
for (const [source, destination] of [
  ['apn-token.cjs', 'lib/server/apn-token.js'],
  ['expand-pattern.cjs', 'lib/api/shared/expand-pattern.js'],
  ['runtime-security-checks.cjs', 'tests/runtime-security.test.js']
]) fs.copyFileSync(path.join(here, 'compat', source), path.join(target, destination));
for (const name of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(profile, name), path.join(target, name));
}
console.log('Nightscout runtime profile applied to verified upstream source');
