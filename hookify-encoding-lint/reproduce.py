#!/usr/bin/env python3
"""Offline cp1252 reproduction; optionally exercise an existing hookify checkout."""

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile


def rule(pattern):
    return (
        '---\nname: sample-rule\nenabled: true\nevent: bash\n'
        'action: block\npattern: "' + pattern + '"\n---\nPlease review.\n'
    )


def portable():
    undefined = []
    for value in range(256):
        try:
            bytes([value]).decode('cp1252')
        except UnicodeDecodeError:
            undefined.append(format(value, '02X'))
    if undefined != ['81', '8D', '8F', '90', '9D']:
        raise RuntimeError('Unexpected Python cp1252 mapping: ' + repr(undefined))

    # U+0401 encodes as D0 81. A single such character poisons the whole file.
    raw = rule('^\u0401$').encode('utf-8')
    failed = False
    try:
        raw.decode('cp1252')
    except UnicodeDecodeError:
        failed = True

    # U+00E9 encodes as C3 A9: both bytes decode, but to the wrong characters.
    pattern = '^\u00e9$'
    corrupted = pattern.encode('utf-8').decode('cp1252')
    escaped = r'^\u00E9$'
    result = {
        'undefined_cp1252_bytes': undefined,
        'decode_failure': failed,
        'utf8_pattern_matches': bool(re.fullmatch(pattern, '\u00e9')),
        'cp1252_pattern_matches': bool(re.fullmatch(corrupted, '\u00e9')),
        'ascii_escape_matches': bool(re.fullmatch(escaped, '\u00e9')),
        'native': None,
    }
    if not (failed and result['utf8_pattern_matches']
            and not result['cp1252_pattern_matches'] and result['ascii_escape_matches']):
        raise RuntimeError('Expected encoding failure or pattern mismatch was not reproduced.')
    return result


def native(plugin):
    loader = None
    version = None
    if plugin:
        root = Path(plugin).resolve()
        if not (root / 'core' / 'config_loader.py').is_file():
            raise ValueError('Plugin directory must contain core/config_loader.py.')
        with (root / '.claude-plugin' / 'plugin.json').open(encoding='utf-8') as handle:
            version = json.load(handle).get('version')
        # Only an explicitly supplied local checkout is imported. No downloads.
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(root))
        from core.config_loader import load_rules
        loader = load_rules

    with tempfile.TemporaryDirectory(prefix='hookify reproduction ') as directory:
        root = Path(directory)
        (root / '.claude').mkdir()
        file = root / '.claude' / 'hookify.sample.local.md'
        file.write_bytes(rule('^\u0401$').encode('utf-8'))
        failed = False
        with file.open('r') as handle:  # Deliberately mirror the upstream bug.
            encoding = handle.encoding
            try:
                handle.read()
            except UnicodeDecodeError:
                failed = True
        result = {
            'platform': sys.platform,
            'encoding': encoding,
            'utf8_mode': sys.flags.utf8_mode,
            'decode_failure': failed,
            'plugin_version': version,
            'loaded_rules': None,
            'loader_log': None,
        }
        if loader:
            previous = Path.cwd()
            log = io.StringIO()
            try:
                os.chdir(root)
                with contextlib.redirect_stderr(log):
                    result['loaded_rules'] = len(loader(event='bash'))
            finally:
                os.chdir(previous)
            result['loader_log'] = log.getvalue()
        result['windows_skip_confirmed'] = (
            sys.platform == 'win32' and encoding.lower().replace('-', '') == 'cp1252'
            and failed and result['loaded_rules'] == 0
        )
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Print a machine-readable report.')
    parser.add_argument('--native', action='store_true', help='Also test the actual default file encoding.')
    parser.add_argument('--plugin', help='Local hookify plugin directory; requires --native. Never downloaded.')
    args = parser.parse_args()
    if args.plugin and not args.native:
        parser.error('--plugin requires --native')
    try:
        report = portable()
        if args.native:
            report['native'] = native(args.plugin)
    except (OSError, ValueError, ImportError, RuntimeError) as error:
        parser.exit(1, 'Reproduction failed: ' + ascii(str(error)) + '\n')
    if args.json:
        print(json.dumps(report, ensure_ascii=True))
    else:
        print('Portable cp1252: undefined bytes 81 8D 8F 90 9D; decode failure confirmed.')
        print('UTF-8 regex matches; cp1252-corrupted regex misses; ASCII escape matches.')
        if report['native'] is not None:
            print('Native observation: ' + json.dumps(report['native'], ensure_ascii=True))
            if not report['native']['windows_skip_confirmed']:
                print('Native Windows plugin skip NOT confirmed by this run.')
        else:
            print('Native Windows plugin skip not tested; see --native --plugin.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
