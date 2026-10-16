"""Applies coworkers' profile requests from the ntfy.sh mailbox to trips.json.

Runs on GitHub's servers every few minutes (see .github/workflows/apply-requests.yml). It accepts only what the
app itself sends: "Profile request: J.B. 🌸" plus the id the phone already uses for it (so it keeps working there).
Following a trip stays on the follower's phone and never comes here.

It never fails the job over ntfy being unreachable or a garbled message: it just tries again next time, so a hiccup
never turns into an error email. Each message is applied once (its id is remembered), so a profile removed in the
editor is not added back by the same request.
"""
import json
import re
import time
import urllib.error
import urllib.request

INBOX = 'https://ntfy.sh/trip-status-1e4522bd34bd56bb'
ICONS = ['🌸', '🌻', '🌵', '🍀', '🍁', '🌙', '⭐', '🔥', '🐝', '🦋', '🐢', '🐬', '🦉', '🍎', '🍋', '🎈', '⚓', '🎵']
REQUEST = re.compile(r'Profile request: ([A-Z]\.[A-Z]\.) (\S+)(?: (p[a-z0-9]{6,20}))?')
STATE = 'tools/requests-state.json'
MAX_PROFILES = 200
MAX_NEW_PER_RUN = 10  # a flood of fake requests can only add a few profiles at a time
KEEP_SEEN = 500


def read_state():
    try:
        with open(STATE, encoding='utf-8') as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def poll(since):
    """Messages after `since` (a time, an ntfy message id or a duration). None when ntfy can't be reached."""
    try:
        with urllib.request.urlopen(INBOX + '/json?poll=1&since=' + str(since), timeout=30) as r:
            lines = r.read().decode('utf-8', 'replace').splitlines()
    except (urllib.error.URLError, OSError, ValueError) as e:
        print('Could not reach ntfy.sh, trying again next time:', e)
        return None
    msgs = []
    for line in lines:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if isinstance(m, dict) and m.get('event') == 'message' and isinstance(m.get('id'), str):
            msgs.append(m)
    return msgs


def main():
    state = read_state()
    seen = [x for x in state.get('seen', []) if isinstance(x, str)]
    # Ask from a minute before the last message read (messages already handled are skipped by id). Older state
    # files kept only the last message id.
    if isinstance(state.get('time'), int):
        since = max(state['time'] - 60, 0)
    else:
        since = state.get('since') or '24h'
    msgs = poll(since)
    if msgs is None:
        return
    new = [m for m in msgs if m['id'] not in seen]
    if not new:
        print('No new requests.')
        return
    with open('trips.json', encoding='utf-8') as f:
        data = json.load(f)
    profiles = data.setdefault('profiles', [])
    added = 0
    last = state.get('time') if isinstance(state.get('time'), int) else 0
    for m in new:
        if added >= MAX_NEW_PER_RUN:
            break  # the rest waits for the next run
        seen.append(m['id'])
        if isinstance(m.get('time'), int):
            last = max(last, m['time'])
        p = REQUEST.fullmatch(str(m.get('message', '')))
        if not p or p.group(2) not in ICONS:
            continue
        ini, icon, pid = p.group(1), p.group(2), p.group(3)
        if len(profiles) >= MAX_PROFILES or any(x.get('initials') == ini and x.get('icon') == icon for x in profiles):
            continue
        if not pid or any(x.get('id') == pid for x in profiles):
            pid = 'p' + format(int(time.time() * 1000), 'x') + re.sub(r'[^a-z0-9]', '', m['id'][:4].lower())
        profiles.append({'id': pid, 'initials': ini, 'icon': icon})
        added += 1
        print('Added profile', ini, icon)
    state = {'time': last, 'seen': seen[-KEEP_SEEN:]}
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=1)
        f.write('\n')
    # "updated" in trips.json is when the trips last changed, so a new profile leaves it alone.
    if added:
        with open('trips.json', 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=1, ensure_ascii=False)
            f.write('\n')


if __name__ == '__main__':
    main()
