"""Tests for tools/apply_requests.py (the GitHub job that adds coworkers' profile requests). Run from the repo root:
    python3 -m unittest discover -s tests -p "test_*.py"
Everything runs in a temporary folder with a stand-in for ntfy.sh; nothing reaches the internet.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import apply_requests  # noqa: E402


def ntfy_lines(*messages):
    out = [json.dumps({'id': 'open1', 'event': 'open'})]
    for i, m in enumerate(messages):
        if isinstance(m, str) and m.startswith('RAW:'):
            out.append(m[4:])
            continue
        mid, text = m if isinstance(m, tuple) else ('m%04dabcd' % i, m)
        out.append(json.dumps({'id': mid, 'time': 1792100000 + i, 'event': 'message', 'message': text}, ensure_ascii=False))
    return ('\n'.join(out) + '\n').encode('utf-8')


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ApplyRequestsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cwd = os.getcwd()
        os.chdir(self.dir)
        os.makedirs('tools')
        self.base = {'updated': '2026-10-19T12:30:00.000Z',
                     'trips': [{'date': '2026-10-20', 'time': '09:15', 'status': 'Assigned', 'id': 't1'}],
                     'profiles': [{'id': 'pq1zz0001', 'initials': 'Q.Z.', 'icon': '🦉'}]}
        self.write(self.base)
        self.urls = []

    def tearDown(self):
        os.chdir(self.cwd)
        shutil.rmtree(self.dir)

    def write(self, data):
        with open('trips.json', 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=1, ensure_ascii=False)
            f.write('\n')

    def read(self):
        with open('trips.json', encoding='utf-8') as f:
            return json.load(f)

    def text(self):
        with open('trips.json', encoding='utf-8') as f:
            return f.read()

    def state(self):
        try:
            with open('tools/requests-state.json') as f:
                return json.load(f)
        except OSError:
            return None

    def run_with(self, body=None, error=None):
        def fake_urlopen(url, timeout=None):
            self.urls.append(url)
            if error:
                raise error
            return FakeResponse(body)
        with mock.patch.object(apply_requests.urllib.request, 'urlopen', fake_urlopen):
            return apply_requests.main()

    def test_adds_a_profile_with_the_phone_id(self):
        self.run_with(ntfy_lines('Profile request: S.P. 🐢 pmvf9hr95wyit'))
        p = self.read()['profiles']
        self.assertEqual(p[-1], {'id': 'pmvf9hr95wyit', 'initials': 'S.P.', 'icon': '🐢'})

    def test_keeps_trips_and_updated_time(self):
        self.run_with(ntfy_lines('Profile request: S.P. 🐢 pmvf9hr95wyit'))
        d = self.read()
        self.assertEqual(d['trips'], self.base['trips'])
        self.assertEqual(d['updated'], self.base['updated'], 'a new profile is not a trip change')

    def test_without_an_id_makes_one(self):
        self.run_with(ntfy_lines('Profile request: S.P. 🐢'))
        p = self.read()['profiles'][-1]
        self.assertRegex(p['id'], r'^p[a-z0-9]{6,20}$')

    def test_skips_duplicates_bad_icons_and_other_text(self):
        self.run_with(ntfy_lines('Profile request: Q.Z. 🦉 pabcdefgh', 'Profile request: A.B. 💀', 'hello', 'Profile request: Jo.B. 🌸',
                                 'Profile request: A.B. 🌸 <script>', 'Profile request: C.D. 🌸 pcd000001', 'Profile request: C.D. 🌸 pcd000002'))
        p = self.read()['profiles']
        self.assertEqual([x['initials'] for x in p], ['Q.Z.', 'C.D.'])

    def test_an_id_already_in_use_gets_a_new_one(self):
        self.run_with(ntfy_lines('Profile request: N.W. 🌙 pq1zz0001'))
        p = self.read()['profiles']
        self.assertEqual(len({x['id'] for x in p}), 2)

    def test_remembers_where_it_stopped(self):
        self.run_with(ntfy_lines(('aaaa11112222', 'Profile request: S.P. 🐢 pmvf9hr95wyit')))
        self.assertIn('aaaa11112222', self.state().get('seen', []) + [self.state().get('since')])

    def test_the_same_message_twice_is_applied_once_even_after_the_profile_was_removed(self):
        body = ntfy_lines(('aaaa11112222', 'Profile request: S.P. 🐢 pmvf9hr95wyit'))
        self.run_with(body)
        d = self.read()
        d['profiles'] = [x for x in d['profiles'] if x['initials'] != 'S.P.']  # Jordan removed it in the editor
        self.write(d)
        self.run_with(body)  # ntfy sends it again (for example when the stored place was forgotten)
        self.assertFalse(any(x['initials'] == 'S.P.' for x in self.read()['profiles']))

    def test_no_connection_is_not_a_failure(self):
        before = self.text()
        self.run_with(error=urllib.error.URLError('down'))
        self.assertEqual(self.text(), before)

    def test_a_garbled_line_is_skipped(self):
        self.run_with(ntfy_lines('RAW:{not json', 'Profile request: S.P. 🐢 pmvf9hr95wyit', 'RAW:'))
        self.assertTrue(any(x['initials'] == 'S.P.' for x in self.read()['profiles']))

    def test_no_new_messages_changes_nothing(self):
        before = self.text()
        self.run_with(ntfy_lines())
        self.assertEqual(self.text(), before)

    def test_caps_profiles(self):
        d = self.read()
        d['profiles'] = [{'id': 'p%08d' % i, 'initials': 'A.A.', 'icon': '🌸'} for i in range(200)]
        self.write(d)
        self.run_with(ntfy_lines('Profile request: S.P. 🐢 pmvf9hr95wyit'))
        self.assertEqual(len(self.read()['profiles']), 200)

    def test_at_most_ten_new_profiles_per_run(self):
        msgs = ['Profile request: %s.%s. 🌸' % (chr(65 + i), chr(66 + i)) for i in range(15)]
        self.run_with(ntfy_lines(*msgs))
        self.assertEqual(len(self.read()['profiles']), 1 + 10)

    def test_writes_utf8_emoji_not_escapes(self):
        self.run_with(ntfy_lines('Profile request: S.P. 🐢 pmvf9hr95wyit'))
        self.assertIn('🐢', self.text())


if __name__ == '__main__':
    unittest.main()
