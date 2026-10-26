import { tokenize } from './tokenize.mjs';

const MAX_COMMAND = 1024 * 1024;
const pathReason = 'Backslashed Windows path outside a literal single-quoted word. Use forward slashes (C:/Users/me), single quotes, or a script file; Bash may remove backslashes before the command runs.';

function pathFinding(parts) {
  const text = parts.map(part => part.text).join('');
  // Match drive roots and UNC roots, then consult lexical context for every
  // backslash. A path may cross quote boundaries within one shell word.
  const roots = /(?:^|[^\w])(?:[a-z]:[\\/]|\\{2,}[\w.-]+\\)/gi;
  for (const root of text.matchAll(roots)) {
    const start = root.index + (/^[a-z]:|^\\/i.test(root[0]) ? 0 : 1);
    let end = start;
    while (end < text.length && !/[\r\n\0;,]/.test(text[end])) end++;
    let offset = 0;
    for (const part of parts) {
      for (let i = 0; i < part.text.length; i++) {
        const literalApostrophe = part.mode === 'unquoted' && part.text === "\\'";
        if (offset + i >= start && offset + i < end && part.text[i] === '\\' && part.mode !== 'single' && !literalApostrophe) {
          return { index: part.index + i, reason: pathReason };
        }
      }
      offset += part.text.length;
    }
  }
}

const executable = value => value.replaceAll('\\', '/').split('/').at(-1).toLowerCase().replace(/\.exe$/, '');
function inlineWrite(command) {
  let i = 0;
  while (i < command.length) {
    const name = executable(command[i].value);
    if (/^[a-z_][a-z_0-9]*=/i.test(command[i].value) ||
        ['env', 'command', 'exec', 'nohup', 'then', 'do', 'if', 'elif', 'while', 'until', '!', '{'].includes(name) ||
        command[i].value.startsWith('-')) i++;
    else break;
  }
  const name = executable(command[i]?.value || '');
  if (!['powershell', 'pwsh', 'cmd'].includes(name)) return;
  const args = command.slice(i + 1).map(token => token.value);
  let script;
  if (name === 'cmd') {
    const at = args.findIndex(arg => /^\/{1,2}[ck]/i.test(arg));
    if (at < 0) return;
    script = [args[at].replace(/^\/{1,2}[ck]/i, ''), ...args.slice(at + 1)].join(' ');
  } else {
    for (let at = 0; at < args.length; at++) {
      const flag = args[at].toLowerCase();
      if (flag.length >= 2 && '-file'.startsWith(flag)) return;
      if ((flag.length >= 2 && '-command'.startsWith(flag)) || flag === '-commandwithargs') {
        script = args.slice(at + 1).join(' ');
        break;
      }
      // PowerShell also accepts a command without an explicit -Command flag.
      if (!flag.startsWith('-')) {
        if (/\.ps1$/i.test(args[at])) return;
        script = args.slice(at).join(' ');
        break;
      }
      if (['-executionpolicy', '-inputformat', '-outputformat', '-workingdirectory', '-windowstyle', '-configurationname', '-version'].includes(flag)) at++;
    }
  }
  if (script === undefined) return;
  const registry = /\b(?:HKCU|HKLM|HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE)(?:\b|:)/i.test(script);
  const writes = /\bSetEnvironmentVariable\s*\(/i.test(script) ||
    /\bsetx(?:\.exe)?(?=[\s"']|$)/i.test(script) ||
    /\breg(?:\.exe)?["']?\s+["']?add\b/i.test(script) ||
    (/\bSet-ItemProperty\b/i.test(script) && registry) ||
    /\$env:[a-z_][\w]*\s*(?:\+?=|\+\+|--)/i.test(script) ||
    (/\b(?:Set-Item|Set-ItemProperty|New-Item|Remove-Item)\b/i.test(script) && /\benv:/i.test(script)) ||
    (name === 'cmd' && /\bset\s+(?:\/[ap]\s+)?["']?[^=\r\n]+=/i.test(script));
  if (writes) return {
    index: command[i].index,
    reason: 'Inline PowerShell or cmd environment/registry write. Put the operation in a reviewed script file and invoke powershell -File ./update.ps1 or cmd /c ./update.cmd; Bash can change backslashes and dollar signs in inline commands.',
  };
}

export function inspectCommand(command, nesting = 0) {
  if (typeof command !== 'string') return [{ index: 0, reason: 'Expected a Bash command string.' }];
  if (command.length > MAX_COMMAND || nesting > 16) return [{ index: 0, reason: 'Command exceeds inspection limits; use a script file.' }];
  let parsed;
  try { parsed = tokenize(command); }
  catch (error) { return [{ index: 0, reason: error.message }]; }
  const findings = parsed.errors.map(error => ({
    index: error.index, reason: `${error.message}; use complete shell syntax or a script file.`,
  }));
  for (const word of parsed.words) {
    const finding = pathFinding(word.parts);
    if (finding) findings.push(finding);
  }
  for (const body of parsed.heredocs) {
    const finding = pathFinding([{ text: body.text, mode: 'heredoc', index: body.index }]);
    if (finding) findings.push(finding);
    if (!body.quoted) {
      // Here-document quote characters are ordinary data. Wrap the body in a
      // double-quote context to inspect only its executable substitutions.
      const wrapped = '"' + body.text.replaceAll('"', '\\"') + '"';
      for (const nested of inspectCommand(wrapped, nesting + 1)) {
        if (/Inline PowerShell|inspection limit/.test(nested.reason)) {
          findings.push({ ...nested, index: body.index });
        }
      }
    }
  }
  for (const commandWords of parsed.commands) {
    const finding = inlineWrite(commandWords);
    if (finding) findings.push(finding);
  }
  return findings.sort((a, b) => a.index - b.index);
}

export function hookDecision(input) {
  const deny = reason => ({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } });
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') {
    return deny('Invalid hook input: expected an object with tool_name and tool_input.command.');
  }
  if (input.tool_name !== 'Bash') return {};
  if (input.hook_event_name && input.hook_event_name !== 'PreToolUse') return {};
  const findings = inspectCommand(input.tool_input?.command);
  return findings.length ? deny([...new Set(findings.map(finding => finding.reason))].join('\n')) : {};
}
