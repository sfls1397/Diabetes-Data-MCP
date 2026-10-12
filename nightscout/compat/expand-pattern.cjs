'use strict';
const { expand } = require('brace-expansion');

// Keep the date-range API, with bounded depth, work and output allocation.
module.exports = function expandPattern(pattern) {
  let depth = 0;
  let tooDeep = false;
  if (typeof pattern === 'string') {
    for (const character of pattern) {
      if (character === '{' && ++depth > 32) tooDeep = true;
      if (character === '}') depth = Math.max(0, depth - 1);
    }
  }
  if (typeof pattern !== 'string' || pattern.length > 4096 || tooDeep) {
    const error = new Error('Date pattern exceeds its input limit');
    error.status = 400;
    throw error;
  }
  return expand(pattern, { max: 4096, maxLength: 262144, maxDepth: 32, maxRewrites: 32 });
};
