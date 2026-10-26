import { afterAll, expect, test } from 'vitest'

if (process.env.LOUD_SCENARIO === 'collection') throw new Error('Cannot collect this test file')

test('ordinary assertion', () => {
  expect(process.env.LOUD_SCENARIO).not.toBe('failure')
})

afterAll(async () => {
  if (process.env.LOUD_SCENARIO === 'after-test') {
    Promise.reject(new Error('Unhandled error after test completion'))
    Promise.reject('Second rejection after test completion')
    await new Promise(setImmediate)
  }
})
