import path from 'node:path';

// Deliberately parse only direct program + script invocations, never a shell.
function tokenize(command) {
  if (typeof command !== 'string' || /[\r\n\0]/.test(command)) return null;
  const words = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === quote) { quote = ''; continue; }
    if (!quote && (c === '"' || c === "'")) { quote = c; started = true; continue; }
    if (!quote && /\s/.test(c)) {
      if (started) words.push(word);
      word = ''; started = false; continue;
    }
    if (!quote && /[;&|<>`()$*?{}\[\]#^]/.test(c)) return null;
    if (quote === '"' && /[$`]/.test(c)) return null;
    // POSIX escaped spaces, without eating Windows path separators.
    if (!quote && c === '\\' && /[ \t]/.test(command[i + 1] ?? '')) {
      word += command[++i]; started = true; continue;
    }
    word += c; started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

export function commandShape(hook, platform = process.platform) {
  if (!hook || hook.type !== 'command') return null;
  let words;
  if (Object.hasOwn(hook, 'args')) {
    if (typeof hook.command !== 'string' || !Array.isArray(hook.args) ||
        !hook.args.every(arg => typeof arg === 'string' && !/[\r\n\0]/.test(arg))) return null;
    words = [hook.command, ...hook.args];
  } else words = tokenize(hook.command);
  if (!words || words.length < 2 || !words[0] || !words[1] ||
      words[0].includes('=') || words[0].startsWith('-') || words[1].startsWith('-')) return null;
  if (words.slice(0, 2).some(word => /[\r\n\0]/.test(word))) return null;
  const windows = platform === 'win32' || words.slice(0, 2).some(word => /^[a-z]:[\\/]|^[\\/]{2}/i.test(word));
  const normalize = word => {
    if (windows) return path.win32.normalize(word).replaceAll('\\', '/').toLowerCase();
    return path.posix.normalize(word);
  };
  return words.slice(0, 2).map(normalize);
}

export function targetShape(entry, options = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.event !== 'string' || !entry.event.trim() ||
      (entry.matcher !== undefined && typeof entry.matcher !== 'string')) {
    throw new TypeError('entry needs an event, optional string matcher, and command');
  }
  if (options.platform !== undefined && !['win32', 'linux', 'darwin'].includes(options.platform)) {
    throw new TypeError('platform must be win32, linux, or darwin');
  }
  const { event, matcher, ...fields } = entry;
  if (fields.type !== undefined && fields.type !== 'command') throw new TypeError('Only command hooks are supported');
  const hook = { ...fields, type: 'command' };
  const command = commandShape(hook, options.platform);
  if (!command) throw new TypeError('Use a direct program + script command (no interpreter flags or shell expressions)');
  // Reject non-JSON inputs before any file changes.
  const encoded = JSON.stringify(hook);
  const copy = JSON.parse(encoded);
  if (JSON.stringify(commandShape(copy, options.platform)) !== JSON.stringify(command)) {
    throw new TypeError('entry must be JSON serializable');
  }
  return { event, matcher: matcher ?? '', command, hook: copy, explicitMatcher: matcher !== undefined };
}
