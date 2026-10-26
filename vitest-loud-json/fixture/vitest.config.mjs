import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: process.env.LOUD_FIXTURE_CACHE,
  test: {
    include: ['passing.spec.mjs'],
    setupFiles: ['./setup.mjs'],
    maxWorkers: 1,
    fileParallelism: false,
  },
}
