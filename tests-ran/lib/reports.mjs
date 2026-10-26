import { countJUnit } from './xml.mjs';

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function totalMatches(total, parts) {
  const sum = parts.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum) || total !== sum) {
    throw new Error('Report counts are inconsistent');
  }
}

function countTap(report) {
  const fields = new Map();
  for (const line of report.split(/\r?\n/)) {
    // Only unindented diagnostics belong to the outer Node summary.
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (.*)$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1]) || !/^\d+$/.test(match[2])) {
      throw new Error(`Invalid or repeated TAP ${match[1]} count`);
    }
    fields.set(match[1], count(Number(match[2]), match[1]));
  }
  const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  if (names.some(name => !fields.has(name))) throw new Error('Incomplete Node TAP summary');
  const [tests, pass, fail, cancelled, skipped, todo] = names.map(name => fields.get(name));
  totalMatches(tests, [pass, fail, cancelled, skipped, todo]);
  return pass + fail;
}

function countJson(report) {
  const value = JSON.parse(report);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Expected a Jest or Vitest JSON report object');
  }
  if (value.wasInterrupted === true) throw new Error('Test run was interrupted');
  const total = count(value.numTotalTests, 'numTotalTests');
  const passed = count(value.numPassedTests, 'numPassedTests');
  const failed = count(value.numFailedTests, 'numFailedTests');
  const pending = count(value.numPendingTests, 'numPendingTests');
  const todo = count(value.numTodoTests === undefined ? 0 : value.numTodoTests, 'numTodoTests');
  totalMatches(total, [passed, failed, pending, todo]);
  if (value.testResults !== undefined) {
    if (!Array.isArray(value.testResults)) throw new Error('Invalid testResults array');
    const actual = { passed: 0, failed: 0, pending: 0, todo: 0 };
    for (const suite of value.testResults) {
      if (!suite || !Array.isArray(suite.assertionResults)) {
        throw new Error('Invalid assertionResults array');
      }
      for (const assertion of suite.assertionResults) {
        if (!assertion || typeof assertion !== 'object') throw new Error('Invalid assertion result');
        if (assertion.wouldRun === true) throw new Error('Tests were collected but not run');
        const status = ['skipped', 'disabled'].includes(assertion.status) ? 'pending' : assertion.status;
        if (!Object.hasOwn(actual, status)) throw new Error('Unknown assertion status');
        actual[status]++;
      }
    }
    if (actual.passed !== passed || actual.failed !== failed || actual.pending !== pending || actual.todo !== todo) {
      throw new Error('JSON summary counts disagree with assertion results');
    }
  }
  return passed + failed;
}

/** Count executed tests, throwing when the report cannot establish a count. */
export function countTests(report, format) {
  if (typeof report !== 'string') throw new TypeError('Report must be a string');
  const text = report.replace(/^\uFEFF/, '');
  switch (format) {
    case 'tap': return countTap(text);
    case 'json': return countJson(text);
    case 'junit': return countJUnit(text);
    default: throw new Error('Format must be tap, json, or junit');
  }
}
