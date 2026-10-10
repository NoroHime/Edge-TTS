/**
 * Parity test against the Python implementation.
 *
 * Usage:
 *   1. generate the fixtures:  python tools/gen_reference.py build/python-reference.json
 *   2. run this file:          node tests/parity.test.ts build/python-reference.json
 *
 * Node 22.6+ can execute .ts directly (type stripping), so no build step is
 * needed here.
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

import { splitByByteLength } from '../src/bytelength.ts'
import { generateSecMsGec } from '../src/edgeTts.ts'
import { hardSplit, joinTextUnits, splitSentences, splitText } from '../src/text.ts'

interface ReferenceCase {
  text: string
  maxChars: number
  minChars: number
  chunks: string[]
}

interface Reference {
  cases: ReferenceCase[]
  secMsGec: { nowMs: number; token: string }[]
  byteSplit: { text: string; limit: number; chunks: string[] }[]
}

const referencePath = process.argv[2] ?? 'build/python-reference.json'

const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as Reference

const encoder = new TextEncoder()

let checks = 0

/* ------------------------------ text splitting ----------------------- */

for (const [index, testCase] of reference.cases.entries()) {
  const actual = splitText(testCase.text, testCase.maxChars, testCase.minChars)

  assert.deepEqual(
    actual,
    testCase.chunks,
    `split case #${index} differs from Python.\n` +
      `TS: ${JSON.stringify(actual)}\n` +
      `PY: ${JSON.stringify(testCase.chunks)}`,
  )

  checks += 1
}

/* ---------------------------- helper behaviour ----------------------- */

assert.deepEqual(splitSentences('\u4ed6\u8bf4\uff1a\u201c\u4f60\u597d\u3002\u201d\u7136\u540e\u8d70\u4e86\u3002'), [
  '\u4ed6\u8bf4\uff1a\u201c\u4f60\u597d\u3002\u201d',
  '\u7136\u540e\u8d70\u4e86\u3002',
])

assert.deepEqual(splitSentences('\u6ca1\u6709\u6807\u70b9\u7684\u4e00\u6bb5\u8bdd'), [
  '\u6ca1\u6709\u6807\u70b9\u7684\u4e00\u6bb5\u8bdd',
])

assert.equal(hardSplit('a'.repeat(50), 10).length > 0, true)

assert.equal(joinTextUnits('\u4e2d\u6587', '\u4e2d\u6587'), '\u4e2d\u6587\u4e2d\u6587')
assert.equal(joinTextUnits('hello', 'world'), 'hello world')
assert.equal(joinTextUnits('\u4e2d\u6587', ' world'), '\u4e2d\u6587 world')
assert.equal(joinTextUnits('', 'x'), 'x')
assert.equal(joinTextUnits('x', ''), 'x')

checks += 8

/* --------------------------- byte splitting -------------------------- */

for (const [index, testCase] of reference.byteSplit.entries()) {
  const actual = splitByByteLength(testCase.text, testCase.limit)

  // The TypeScript port must never exceed the byte budget, whatever upstream does.
  for (const [chunkIndex, chunk] of actual.entries()) {
    const size = encoder.encode(chunk).length

    assert.ok(
      size <= testCase.limit,
      `byte-split case #${index} chunk #${chunkIndex} is ${size} bytes, ` +
        `over the ${testCase.limit}-byte budget.`,
    )
  }

  // Nobody should lose characters.
  const rebuilt = actual.join('')
  const expectedRebuilt = testCase.chunks.join('')

  assert.equal(
    rebuilt.replace(/\s+/g, ''),
    expectedRebuilt.replace(/\s+/g, ''),
    `byte-split case #${index} lost characters.`,
  )

  // Where upstream itself respects the budget, the results must match exactly.
  const upstreamRespectsLimit = testCase.chunks.every(
    (chunk) => encoder.encode(chunk).length <= testCase.limit,
  )

  if (upstreamRespectsLimit) {
    assert.deepEqual(
      actual,
      testCase.chunks,
      `byte-split case #${index} differs from Python.\n` +
        `TS: ${JSON.stringify(actual)}\n` +
        `PY: ${JSON.stringify(testCase.chunks)}`,
    )

    checks += 1
  } else {
    // Documented divergence: upstream edge-tts emits one oversized request
    // when the text has no newline or space; we split it instead.
    console.log(
      `note: byte-split case #${index} - upstream emitted ` +
        `${testCase.chunks.length} chunk(s), one of them ` +
        `${encoder.encode(testCase.chunks[0]).length} bytes ` +
        `(over ${testCase.limit}); we produced ${actual.length} capped chunk(s).`,
    )
  }
}

/* --------------------------- Sec-MS-GEC token ------------------------ */

for (const sample of reference.secMsGec) {
  const actual = await generateSecMsGec(sample.nowMs)

  assert.equal(
    actual,
    sample.token,
    `Sec-MS-GEC mismatch at now=${sample.nowMs}.\nTS: ${actual}\nPY: ${sample.token}`,
  )

  checks += 1
}

console.log(
  `OK - ${checks} checks passed (text splitting / byte splitting / Sec-MS-GEC)`,
)
