'use strict';
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
