#!/usr/bin/env python3
"""A stand-in Claude Code for live checks: reads prompts typed into its terminal and
writes Claude Code-shaped transcript entries (prompt, thinking, a Bash call and its
result, a reply, the turn's duration) to a JSONL file, reporting working/done over
OSC 7501 like a real agent. Only ever writes the file it is given.

usage: fake-agent.py <transcript.jsonl>
"""
import json
import sys
import termios
import time
import tty
import uuid
from datetime import datetime, timezone

path = sys.argv[1]


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def write(entry):
    entry.setdefault('uuid', str(uuid.uuid4()))
    entry.setdefault('timestamp', now())
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry) + '\n')


def status(state):
    sys.stdout.write(f'\033]7501;state={state}:app=fake-agent\033\\')
    sys.stdout.flush()


def ask():
    """Claude Code's permission menu: blocked until one key (1 or 2) arrives."""
    print('Do you want to proceed?', flush=True)
    print(' ❯ 1. Yes', flush=True)
    print('   2. No, and tell Claude what to do differently (esc)', flush=True)
    status('blocked')
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        while True:
            ch = sys.stdin.read(1)
            if ch in ('1', '2', '\x1b'):
                return ch == '1'
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def assistant(block):
    return {'type': 'assistant', 'message': {'id': 'msg_' + uuid.uuid4().hex[:8], 'model': 'claude-opus-5-5', 'role': 'assistant',
                                             'content': [block], 'usage': {'input_tokens': 3, 'cache_read_input_tokens': 4000, 'output_tokens': 20}}}


print('fake agent ready: type a prompt and press Enter', flush=True)
status('idle')
for raw in sys.stdin:
    text = raw.replace('\x1b[200~', '').replace('\x1b[201~', '').strip()
    if not text:
        continue
    t0 = time.time()
    write({'type': 'user', 'message': {'role': 'user', 'content': text}, 'origin': {'kind': 'human'}})
    status('working')
    print(f'> {text}', flush=True)
    time.sleep(0.4)
    write({**assistant({'type': 'thinking', 'thinking': f'The person said "{text}". I will run one command.', 'signature': 'x'}),
           'thinkingDurationMs': 400})
    tool = 'toolu_' + uuid.uuid4().hex[:12]
    write(assistant({'type': 'tool_use', 'id': tool, 'name': 'Bash', 'input': {'command': f'echo {json.dumps(text)} | wc -c', 'description': 'Count the characters'}}))
    time.sleep(0.5)
    out = str(len(text) + 1)
    if 'permission' in text and not ask():
        status('working')
        write({'type': 'user', 'message': {'role': 'user', 'content': [{'tool_use_id': tool, 'type': 'tool_result', 'content': 'The user rejected this tool use.', 'is_error': True}]},
               'toolUseResult': 'Error: The user rejected this tool use.'})
        out = 'refused'
    else:
        status('working')
        write({'type': 'user', 'message': {'role': 'user', 'content': [{'tool_use_id': tool, 'type': 'tool_result', 'content': out, 'is_error': False}]},
               'toolUseResult': {'stdout': out, 'stderr': '', 'interrupted': False, 'isImage': False}})
    write(assistant({'type': 'text', 'text': f'You said **{text}**: that is `{out}` bytes with the newline.'}))
    write({'type': 'system', 'subtype': 'turn_duration', 'durationMs': int((time.time() - t0) * 1000), 'isMeta': False})
    print(f'reply written ({out} bytes)', flush=True)
    status('done')
