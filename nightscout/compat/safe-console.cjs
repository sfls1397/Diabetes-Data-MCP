'use strict';
// The connector logs whole credential configs, sessions and Axios request objects.
// Preserve warning/error signals while accepting no caller-provided log content.
module.exports = {
  log() {}, info() {}, debug() {},
  warn() { process.stderr.write('nightscout-connect: warning\n'); },
  error() { process.stderr.write('nightscout-connect: error\n'); }
};
