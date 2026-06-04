/**
 * Unit test for the shared narration-source guard used by BOTH the fresh-upload
 * path and the "Choose from storage" reuse path in UploadZone. Pure function, no
 * DOM — run with: cd lab && npx tsx src/utils/videoValidation.test.ts
 */
import assert from 'node:assert/strict';
import { validateNarrationMeta } from './videoValidation.js';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}

// A vertical 9:16 clip is ~0.5625 aspect ratio. 0.7 is the cutoff.
check('accepts a vertical 30s clip', () => {
  assert.equal(validateNarrationMeta(30, 9 / 16), null);
});
check('accepts the 15s lower bound', () => {
  assert.equal(validateNarrationMeta(15, 0.56), null);
});
check('accepts the 90s upper bound', () => {
  assert.equal(validateNarrationMeta(90, 0.56), null);
});
check('rejects a landscape clip', () => {
  assert.match(validateNarrationMeta(30, 16 / 9) ?? '', /vertical/i);
});
check('rejects a square clip (1.0 > 0.7)', () => {
  assert.match(validateNarrationMeta(30, 1) ?? '', /vertical/i);
});
check('rejects too-short clip', () => {
  assert.match(validateNarrationMeta(10, 0.56) ?? '', /15.?90/);
});
check('rejects too-long clip', () => {
  assert.match(validateNarrationMeta(120, 0.56) ?? '', /15.?90/);
});
check('aspect ratio is checked before duration', () => {
  // Bad on both axes → the aspect-ratio message wins (matches UploadZone order).
  assert.match(validateNarrationMeta(5, 2) ?? '', /vertical/i);
});

console.log(`\n${passed} passed`);
