import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

describe('Nightscout repair boundaries', () => {
  it('maps legacy Share region enums into enabled connector settings at launch', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diabetes-launch-probe-'));
    fs.mkdirSync(path.join(temporary, 'runtime/nightscout'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'runtime/nightscout/server.js'), '');
    fs.writeFileSync(path.join(temporary, 'security'), '#!/bin/sh\nprintf fixture\\n');
    fs.writeFileSync(path.join(temporary, 'nc'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(temporary, 'node-probe'), '#!/bin/sh\nprintf "REGION=%s ENABLE=%s\\n" "$CONNECT_SHARE_REGION" "$ENABLE"\n');
    for (const name of ['security', 'nc', 'node-probe']) fs.chmodSync(path.join(temporary, name), 0o700);
    try {
      for (const [server, region] of [['US', 'us'], ['EU', 'ous']]) {
        fs.writeFileSync(path.join(temporary, 'config.env'), `BRIDGE_ENABLE=1\nBRIDGE_SERVER=${server}\n`);
        const output = execFileSync('/bin/sh', [path.join(root, 'nightscout/diabetes-nightscout-server')], {
          env: { ...process.env, PATH: temporary + ':' + process.env.PATH,
            NODE_BIN: path.join(temporary, 'node-probe'), DIABETES_NIGHTSCOUT_HOME: temporary }, encoding: 'utf8'
        });
        expect(output).toContain(`REGION=${region}`);
        expect(output).toContain('bridge connect');
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
  it('never includes connector credential or session objects in diagnostics', () => {
    const logger = require('../nightscout/compat/safe-console.cjs');
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (const method of ['log', 'info', 'debug', 'warn', 'error']) {
        logger[method]('fixture-private-value', { password: 'fixture-private-value' });
      }
      expect(output.mock.calls.map(call => call[0]).join('')).toBe(
        'nightscout-connect: warning\nnightscout-connect: error\n'
      );
    } finally {
      output.mockRestore();
    }
  });

  it('rejects an unexpected connector source before changing any files', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diabetes-connect-probe-'));
    const connector = path.join(temporary, 'node_modules/nightscout-connect');
    fs.mkdirSync(connector, { recursive: true });
    fs.writeFileSync(path.join(connector, 'package.json'), '{"version":"0.0.13"}');
    const files = JSON.parse(fs.readFileSync(path.join(root, 'nightscout/runtime-profile/connect-sources.json'), 'utf8'));
    const first = Object.keys(files)[0];
    const source = path.join(connector, first);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, '// unexpected source\n');
    try {
      expect(() => execFileSync(process.execPath, [path.join(root, 'nightscout/sanitize-connect.mjs'), temporary], {
        stdio: 'pipe'
      })).toThrow();
      expect(fs.readFileSync(source, 'utf8')).toBe('// unexpected source\n');
      expect(fs.existsSync(path.join(connector, 'diabetes-safe-console.js'))).toBe(false);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
