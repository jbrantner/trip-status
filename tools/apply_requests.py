"""Applies coworkers' profile requests from the ntfy.sh mailbox to trips.json.

Runs on GitHub's servers every few minutes (see .github/workflows/apply-requests.yml). It accepts only what the
app itself sends: "Profile request: J.B. 🌸". Following a trip stays on the follower's phone and never comes here.
"""
import json, re, time, urllib.request
from datetime import datetime, timezone

INBOX = 'https://ntfy.sh/trip-status-1e4522bd34bd56bb'
ICONS = ['🌸', '🌻', '🌵', '🍀', '🍁', '🌙', '⭐', '🔥', '🐝', '🦋', '🐢', '🐬', '🦉', '🍎', '🍋', '🎈', '⚓', '🎵']
STATE = 'tools/requests-state.json'

def main():
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    since = state.get('since') or '24h'
    with urllib.request.urlopen(INBOX + '/json?poll=1&since=' + since, timeout=30) as r:
        lines = r.read().decode('utf-8').splitlines()
    msgs = [m for m in (json.loads(l) for l in lines if l.strip()) if m.get('event') == 'message']
    if not msgs:
        print('No new requests.')
        return
    data = json.load(open('trips.json', encoding='utf-8'))
    profiles = data.setdefault('profiles', [])
    trips = data.setdefault('trips', [])
    changed = False
    for m in msgs:
        text = str(m.get('message', ''))
        p = re.fullmatch(r'Profile request: ([A-Z]\.[A-Z]\.) (\S+)', text)
        if p and p.group(2) in ICONS:
            ini, icon = p.group(1), p.group(2)
            if any(x['initials'] == ini and x['icon'] == icon for x in profiles):
                continue
            if len(profiles) >= 200:
                continue
            profiles.append({'id': 'p' + format(int(time.time() * 1000), 'x') + m['id'][:4].lower(), 'initials': ini, 'icon': icon})
            print('Added profile', ini, icon)
            changed = True
            continue
    state['since'] = msgs[-1]['id']
    json.dump(state, open(STATE, 'w'), indent=1)
    if changed:
        data['updated'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        with open('trips.json', 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=1, ensure_ascii=False)
            f.write('\n')

if __name__ == '__main__':
    main()
