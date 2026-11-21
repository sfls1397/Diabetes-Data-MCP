'use strict';
module.exports = {
  log() {}, info() {}, debug() {},
  warn() { process.stderr.write('nightscout-connect: warning\n'); },
  error() { process.stderr.write('nightscout-connect: error\n'); }
};
