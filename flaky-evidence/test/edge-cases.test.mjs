import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithEvidence, sampleResources } from '../index.mjs';

test('CPU improvement exactly at the threshold is unexplained despite floating point rounding', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'flaky edge '));
  let sample = 0;
  let execute = 0;
  const result = await runWithEvidence(['fake'], { cwd }, {
    sample: async () => ({ freeMemoryBytes: 500, totalMemoryBytes: 1000,
      cpuBusyShare: sample++ ? 0.7 : 0.9, cpuSampleMs: 1000, processCount: 20 }),
    execute: async () => ({ exitCode: execute++ ? 0 : 9, durationMs: 1 }),
  });
  assert.equal(result.evidence.classification.kind, 'unexplained');
  assert.deepEqual(result.evidence.classification.reasons, []);
  assert.equal(result.exitCode, 9);
});

test('memory readings from different machine capacities do not suggest pressure', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'flaky capacity '));
  let sample = 0;
  let execute = 0;
  const result = await runWithEvidence(['fake'], { cwd }, {
    sample: async () => sample++ ? { freeMemoryBytes: 1500, totalMemoryBytes: 2000 }
      : { freeMemoryBytes: 50, totalMemoryBytes: 1000 },
    execute: async () => ({ exitCode: execute++ ? 0 : 4, durationMs: 1 }),
  });
  assert.equal(result.evidence.classification.kind, 'unexplained');
});

test('failed CPU sampling preserves memory and marks CPU unavailable', async () => {
  const result = await sampleResources({ cpus: () => { throw new Error('CPU unavailable'); },
    freemem: () => 100, totalmem: () => 1000, sleep: async () => {}, countProcesses: async () => null });
  assert.equal(result.cpuBusyShare, null);
  assert.equal(result.freeMemoryBytes, 100);
  assert.match(result.errors.join(' '), /CPU unavailable/);
});

test('unique default evidence paths allow separate invocations in the same directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'flaky unique '));
  const dependencies = { sample: async () => ({}), execute: async () => ({ exitCode: 0, durationMs: 1 }) };
  const results = await Promise.all([
    runWithEvidence(['first'], { cwd }, dependencies), runWithEvidence(['second'], { cwd }, dependencies),
  ]);
  assert.notEqual(results[0].evidencePath, results[1].evidencePath);
  for (let i = 0; i < results.length; i++) {
    const saved = JSON.parse(await readFile(results[i].evidencePath, 'utf8'));
    assert.equal(saved.command[0], i ? 'second' : 'first');
    assert.equal(saved.status, 'complete');
  }
});
