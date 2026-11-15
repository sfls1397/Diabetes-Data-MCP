'use strict';
// Mocha root hook plugin for scripts/nightscout-local-test.sh. Mocha prints nothing when a test passes only on its
// --retries attempt, so a real intermittent regression would pass unseen: name each such test on a gate-warning line,
// which local-gate.py shows under a passing step. Never changes a result; a test that fails every time still fails.
const retried = [];

exports.mochaHooks = {
  afterEach() {
    const test = this.currentTest;
    if (test && test.state === 'passed' && test.currentRetry() > 0) retried.push(test.fullTitle().replace(/\s+/g, ' '));
  },
  afterAll() {
    for (const title of retried) console.log(`gate-warning: Nightscout test passed only on retry: ${title}`);
    console.log(`Nightscout tests passed only on retry: ${retried.length}`);
  },
};
