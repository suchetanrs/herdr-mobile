#!/usr/bin/env python3
"""A stand-in agent that asks for permission, for live checks of one-tap answers: draws a
Claude Code-shaped numbered menu, reports `blocked` over OSC 7501, reads one key, prints
"ANSWERED <key>", reports `done`, then asks again. Writes nothing anywhere.

usage: fake-ask.py
"""
import sys
import termios
import tty

MENU = """
 Bash command
   rm -rf build
 Do you want to proceed?
 > 1. Yes
   2. Yes, and don't ask again for rm
   3. No, and tell Claude what to do differently
"""


def osc(state):
    sys.stdout.write(f"\033]7501;state={state}:app=hm-ask\033\\")
    sys.stdout.flush()


fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setcbreak(fd)
try:
    while True:
        sys.stdout.write(MENU)
        osc("blocked")
        key = sys.stdin.read(1)
        osc("working")
        sys.stdout.write(f"\nANSWERED {key!r}\n")
        osc("done")
        sys.stdout.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
