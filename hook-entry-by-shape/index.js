import { commandShape, targetShape } from './lib/shape.js';
import { readSettings, writeSettings } from './lib/storage.js';
import { parseDocument, member, decode, append, deletions, applyEdits } from './lib/json.js';

function inspect(settingsPath, entry, options) {
  const target = targetShape(entry, options);
  const snapshot = readSettings(settingsPath);
  const root = parseDocument(snapshot.text);
  if (root.kind !== 'object') throw new TypeError('Settings must be a JSON object');
  const hooks = member(root, 'hooks');
  if (hooks && hooks.kind !== 'object') throw new TypeError('settings.hooks must be an object');
  const event = hooks && member(hooks, target.event);
  if (event && event.kind !== 'array') throw new TypeError('Hook event must contain an array of groups');
  const matches = [];
  const groups = [];
  for (const [groupIndex, node] of (event?.children ?? []).entries()) {
    if (node.kind !== 'object') throw new TypeError('Hook group must be an object');
    const handlers = member(node, 'hooks');
    if (!handlers || handlers.kind !== 'array') throw new TypeError('Hook group must contain a hooks array');
    groups.push(handlers);
    const matcherNode = member(node, 'matcher');
    const matcher = matcherNode ? decode(snapshot.text, matcherNode) : '';
    if (matcher !== target.matcher) continue;
    for (const [hookIndex, handler] of handlers.children.entries()) {
      const hook = decode(snapshot.text, handler);
      const shape = commandShape(hook, options?.platform);
      if (shape && shape[0] === target.command[0] && shape[1] === target.command[1]) {
        matches.push({ event: target.event, matcher, groupIndex, hookIndex, hook });
      }
    }
  }
  return { target, snapshot, root, hooks, event, groups, matches };
}

/** Return matching handlers in file order, with their group and handler indices. */
export function find(settingsPath, entry, options) {
  return inspect(settingsPath, entry, options).matches;
}

/** Install one command handler only if its shape is absent. */
export function install(settingsPath, entry, options) {
  const context = inspect(settingsPath, entry, options);
  const { target, snapshot, root, hooks, event, matches } = context;
  if (matches.length) return { changed: false, added: 0, backupPath: null };
  const group = { ...(target.explicitMatcher ? { matcher: target.matcher } : {}), hooks: [target.hook] };
  let edit;
  if (event) edit = append(event, JSON.stringify(group));
  else if (hooks) edit = append(hooks, JSON.stringify(target.event) + ':' + JSON.stringify([group]));
  else edit = append(root, '"hooks":' + JSON.stringify({ [target.event]: [group] }));
  const text = applyEdits(snapshot.text, [edit]);
  return { changed: true, added: 1, backupPath: writeSettings(snapshot, text) };
}

function erase(settingsPath, entry, options, keepFirst) {
  const { snapshot, event, groups, matches } = inspect(settingsPath, entry, options);
  const selected = matches.slice(keepFirst ? 1 : 0);
  if (!selected.length) return { changed: false, removed: 0, backupPath: null };
  const byGroup = new Map();
  for (const { groupIndex, hookIndex } of selected) {
    if (!byGroup.has(groupIndex)) byGroup.set(groupIndex, new Set());
    byGroup.get(groupIndex).add(hookIndex);
  }
  const edits = [], emptyGroups = new Set();
  for (const [groupIndex, indices] of byGroup) {
    if (indices.size === groups[groupIndex].children.length) emptyGroups.add(groupIndex);
    else edits.push(...deletions(groups[groupIndex], indices));
  }
  edits.push(...deletions(event, emptyGroups));
  const text = applyEdits(snapshot.text, edits);
  return { changed: true, removed: selected.length, backupPath: writeSettings(snapshot, text) };
}

/** Remove all matching handlers, preserving unrelated handlers in mixed groups. */
export function remove(settingsPath, entry, options) {
  return erase(settingsPath, entry, options, false);
}

/** Keep the first matching handler verbatim, removing only subsequent matches. */
export function repair(settingsPath, entry, options) {
  return erase(settingsPath, entry, options, true);
}
