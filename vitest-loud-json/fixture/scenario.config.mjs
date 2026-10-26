import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: process.env.LOUD_FIXTURE_CACHE,
  test: {
    include: ['scenario.spec.mjs'],
    maxWorkers: 1,
    fileParallelism: false,
    globalSetup: ['./global-setup.mjs'],
    reporters: [
      ['json', { outputFile: process.env.LOUD_FIXTURE_REPORT }],
      fileURLToPath(new URL('../reporter.mjs', import.meta.url)),
    ],
  },
}
