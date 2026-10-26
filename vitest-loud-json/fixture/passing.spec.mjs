import { expect, test } from 'vitest'

test('a passing test does not make a background failure safe', () => {
  expect(2 + 2).toBe(4)
})
