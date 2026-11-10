import os,json
home=os.path.expanduser('~'); out={}; cache={}
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try:
        if open(f'/proc/{pid}/comm').read().strip()!='claude': continue
        env=dict(l.split('=',1) for l in open(f'/proc/{pid}/environ','rb').read().decode(errors='ignore').split('\0') if '=' in l)
    except Exception: continue
    t=env.get('HC_TERMINAL_ID')
    if not t: continue
    d=env.get('CLAUDE_CONFIG_DIR'); f=os.path.join(d,'.claude.json') if d else os.path.join(home,'.claude.json')
    if f not in cache:
        try:
            o=json.load(open(f)).get('oauthAccount') or {}
            cache[f]=[(o.get('emailAddress') or '?').split('@')[0], (o.get('planDisplayName') or o.get('organizationType') or '').lower()]
        except Exception: cache[f]=None
    if cache[f]: out[t]=cache[f]
print(json.dumps(out))
