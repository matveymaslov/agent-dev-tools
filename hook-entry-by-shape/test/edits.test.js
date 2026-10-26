import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as api from 'hook-entry-by-shape';
import { temporaryDirectory } from './temp.js';

test('public package exports preserve every arrangement of alternating matches and survivors', t => {
  const dir = temporaryDirectory('hook-edits-');
  t.after(() => {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const file = path.join(dir, 'settings.json');
  const entry = { event: 'Stop', command: 'node check.js' };
  for (let mask = 0; mask < 32; mask++) {
    const hooks = Array.from({ length: 5 }, (_, index) => ({
      type: 'command', command: mask & (1 << index) ? 'node check.js' : `node other-${index}.js`,
    }));
    const other = hooks.filter(hook => hook.command !== entry.command);
    for (const pretty of [undefined, 2]) {
      const source = JSON.stringify({ value: 'keep', hooks: { Stop: [{ hooks }] } }, null, pretty);
      fs.writeFileSync(file, source);
      assert.equal(api.find(file, entry).length, 5 - other.length);
      api.remove(file, entry);
      assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
        value: 'keep', hooks: { Stop: other.length ? [{ hooks: other }] : [] },
      });
    }
  }
});
