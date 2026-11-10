# Terminals whose claude runs a Bash tool command (background work): Claude Code reports done
# when its turn ends even while such a command (its own, or a background sub-agent's) still runs.
import os,json
out=set()
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try:
        if open(f'/proc/{pid}/comm').read().strip()!='claude': continue
        env=dict(l.split('=',1) for l in open(f'/proc/{pid}/environ','rb').read().decode(errors='ignore').split('\0') if '=' in l)
        t=env.get('HC_TERMINAL_ID')
        if not t: continue
        for k in open(f'/proc/{pid}/task/{pid}/children').read().split():
            try:
                if b'/shell-snapshots/snapshot-' in open(f'/proc/{k}/cmdline','rb').read(): out.add(t); break
            except Exception: pass
    except Exception: continue
print(json.dumps(sorted(out)))
