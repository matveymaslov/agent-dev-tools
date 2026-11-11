# diagnosis-needs-evidence

An agent that keeps a work journal writes down what it thinks went wrong, and the next
step, or the next session, reads that line as settled. The line is often written before
the code behind it has been read: "Cause: the retry loop never backs off." Nothing in it says
it is a guess. The wrong thing gets fixed, and the journal keeps the wrong diagnosis on
record as fact. In the project this tool came from, that happened twice in two days.

This is a Claude Code `PreToolUse` hook that reads the text an agent is about to add to
its journal. A sentence that names a cause is refused unless that sentence, or the one
after it, carries evidence: a reference to code (`path/file.ext:line`) or an explicit mark
that it is a guess. The refusal quotes the sentence and says how to fix it, and the agent
rewrites the line.

Zero dependencies. Requires Node.js 22 or newer. MIT licensed. Runs on Windows and Linux.

## Install

This folder is the entire package. No dependency installation, build step, or network
access is needed:

```sh
node /path/to/agent-dev-tools/diagnosis-needs-evidence/bin/diagnosis-needs-evidence.mjs --help
```

Merge this entry into your `.claude/settings.json` (project or user). Replace the example
path with the absolute location of the script; write Windows paths with forward slashes:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/agent-dev-tools/diagnosis-needs-evidence/bin/diagnosis-needs-evidence.mjs\""
          }
        ]
      }
    ]
  }
}
```

The hook reads one JSON object from stdin (`tool_name` and `tool_input`). It denies a call
by exiting **2** with the reason on stderr; Claude Code shows that reason to the agent, as
described in the [hook reference](https://code.claude.com/docs/en/hooks). It lets a call
through by exiting **0**. Installation is manual: nothing here rewrites your settings.

## What is judged

| Tool call | What is read |
| --- | --- |
| `Write` to a journal | Only the lines the write **adds** to the file as it is now. Lines are compared as a multiset, so an old bare line that the write keeps is not judged, and a second copy of it is. A file that does not exist yet is judged in full. |
| `Edit` of a journal | `new_string`. |
| `Bash` | The whole command, but only when it **writes to a journal**: a target of `>`, `>>`, `>\|` or `&>`, a file given to `tee`, `sed -i` or `perl -i`, or the script of `bash -c` / `eval`. |
| Anything else | Not read. |

`MultiEdit`, in Claude Code versions that still have it, is handled like `Edit` for each
of its edits; add it to the matcher (`Edit|MultiEdit|Write|Bash`) to use that.

The shell reader follows quotes, comments, here-document bodies and command separators.
So these are **not** writes: `x=>x` and `a>=b`, a `>` inside a string, `> /dev/null`,
`2>&1`, `2>> file` (it adds the command's error output, not text the agent wrote), and a
command that merely names the journal (`grep cause RUN-LOG.md`). A target that cannot be
read from the text, such as `>> "$LOG"`, counts as a write to the journal when the command
names a journal somewhere else.

A sentence ends at `.`, `;`, `!`, `?` or `…` followed by whitespace, or at a line break.

### Examples

Refused:

```text
- 10:00 stall on job 7. Cause: the retry loop never backs off.
- 10:00 причина: нехватка памяти.
- 10:00 diagnosis: the cache key was reused across requests.
```

Accepted:

```text
- 10:00 Cause: the retry loop never backs off (src/retry.mjs:212).
- 10:00 The cause is the retry loop. Read in src/retry.mjs ~212.
- 10:00 Cause: the retry loop never backs off, a guess, code not read yet.
- 10:00 причина, вероятно, в нагрузке: догадка.
```

The refusal looks like this:

```text
diagnosis-needs-evidence: refused. This text is going into a work journal and names a cause without evidence: "- 10:00 Cause: the retry loop never backs off.".
Put a reference to code you have read in that sentence or the next one (path/file.ext:line, path/file.ext ~line or path/file.ext line N), or mark the sentence as a guess ("guess", "hypothesis", "not read", "not checked"). Then write it again.
```

## What counts

A sentence **names a cause** when it contains one of these words, whole and in any letter
case: `cause`, `causes`, `caused`, `root cause`, `diagnosis`, `diagnosed`, `diagnoses`,
`причина`, `диагноз` (and their Russian case endings). Words that merely contain them,
such as `because`, `causal` or `diagnostic`, do not count.

**Evidence** is either of these, in the sentence itself or the one after it:

- A **reference** `path/file.ext:line`, also `path/file.ext ~line`, `path/file.ext line N`
  (`lines N-M`, `, line N`, `строка N`) and `path/file.ext#L12`, with an extension from
  a fixed list of source, config and log types. `api.example.com:443` is not a reference.
- A **guess mark**: `guess`, `guessed`, `hypothesis`, `not read`, `not checked`, and the
  Russian `догадка`, `гипотеза`, `не читал`, `не проверял` with their usual forms.

## Which files are journals

By default: any file whose name contains `RUN-LOG` or `JOURNAL` and ends in `.md`, in any
directory, in any letter case (`PHASE-3-RUN-LOG.md`, `notes/journal.md`).

To change that, give one or more patterns with `--journal` (repeatable, also
`--journal=<pattern>`) in the hook command, or set `DIAGNOSIS_NEEDS_EVIDENCE_JOURNAL` (one
pattern per line). A flag wins over the variable, and either one **replaces** the default.

```sh
node /path/to/agent-dev-tools/diagnosis-needs-evidence/bin/diagnosis-needs-evidence.mjs \
  --journal 'docs/journal/*.md' --journal '/\.journal$/'
```

Quote a glob so your shell does not expand it.

| Pattern | Meaning |
| --- | --- |
| a glob, such as `docs/journal/*.md` | `*` and `?` do not cross a `/`; `**` does (`notes/**/log.md` also matches `notes/log.md`); `{a,b}` lists alternatives; no character classes. Matched case-insensitively against the end of the path, from a directory boundary: `docs/*.md` matches `/repo/docs/a.md`, not `/repo/xdocs/a.md`. A glob that starts with `/` or a drive letter must match from the start. |
| `/regex/` or `/regex/i` | A regular expression tested against the whole path written with forward slashes. Case-sensitive unless it ends in `/i`. |

Backslashes in paths, in patterns and in commands are read as slashes.

In the settings file, the `command` value of the hook above then becomes (the JSON string
escapes the double quotes; the single quotes keep the glob away from the shell):

```text
"node \"/path/to/agent-dev-tools/diagnosis-needs-evidence/bin/diagnosis-needs-evidence.mjs\" --journal 'docs/journal/*.md'"
```

## Exit codes and failures

| Exit | Meaning |
| --- | --- |
| 2 | Denied. The sentence and the fix are on stderr. |
| 0 | Let through: nothing to judge, a sound entry, or the check failed on its own. In the last case a note is on stderr (for example an unreadable journal file, or stdin that is not JSON). **The hook never blocks on its own bug.** |
| 1 | Configuration error: an unknown flag, or a pattern that does not compile. Claude Code treats this as a non-blocking error: the call goes through and the message is shown, so a broken setup does not stay silent. |

## Library

```js
import { decide, bareCauses, journalMatcher } from './lib/index.mjs';

const { code, stderr } = decide(
  { tool_name: 'Edit', tool_input: { file_path: 'notes/RUN-LOG.md', new_string: 'Cause: the cache.' } },
  { journals: ['*RUN-LOG*.md'] }, // optional; defaults to the patterns above
);
// code 2, stderr names the sentence

bareCauses('Cause: the cache. Read lib/a.mjs:7.'); // []
```

`decide(input, options?)` returns `{ code, stderr }` and never throws. `bareCauses(text)`
returns the offending sentences, trimmed and cut at 160 characters.

## Limits

This tool reads prose. It catches the honest mistake, an agent that wrote a guess down as
a fact, and **not an adversary**. It does not catch:

- A reference that is made up or wrong. `a.mjs:1` passes, whether or not line 1 says what
  the sentence claims. It does not open the file.
- A cause described without a cause word ("the reason it stalls is ..."), in another
  language, or split so that the evidence is more than one sentence away.
- A write spelled in a way it does not recognise. Only `>`, `>>`, `>|`, `&>`, `tee`,
  `sed -i`, `perl -i` and the script of `bash -c` / `eval` are seen. `python -c`,
  `node -e` with `fs.appendFileSync`, `cp`, `mv`, `dd`, `Add-Content`, a script that
  writes the file, a process substitution or a tool other than `Edit`, `Write` and `Bash`
  pass untouched.

It also refuses some honest text: the word `cause` as a verb ("this can cause delays") names
a cause as far as it can tell, and a reference-shaped string such as `notes.md: 3 items`
counts as evidence. For a `Bash` write the text judged is the command, not the output it
will produce. The reader is not a shell parser: unusual quoting can hide or invent a
redirection.

## Tests

From this folder:

```sh
npm test
# or, with no npm involved:
node --test test/diagnosis-needs-evidence.test.mjs
```

The suite uses only Node built-ins, temporary files and direct child processes, and no
network. It covers the full set of cases the hook was first built against (refused,
accepted, journal read only, arrow function, `>>` beside an arrow function), plus `Write`
judged by added lines, the shell writers, glob and regular-expression journal patterns,
Russian and English forms, failure paths that must let the call through, and the command
line. It also parses the settings snippet in this README.
