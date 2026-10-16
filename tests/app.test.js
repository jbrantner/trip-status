// Trip Status end-to-end tests. Run: node tests/app.test.js [filter]   (needs Playwright; see tests/README.md)
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { test, assert, eq, open, sampleData, helperHash, FakeGitHub, FakeNtfy, NOW, sleep, startServer, siteCopy } = H;

const KEY = 'github_pat_GOOD';
const withKey = (extra) => Object.assign({ 'trip-status-key': KEY }, extra || {});

// What the list shows: one entry per day, with its trips.
async function listed(page) {
  return page.$$eval('#days .day', (days) => days.map((d) => ({
    day: d.querySelector('h2').textContent.replace(/\s+/g, ' ').trim(),
    trips: Array.from(d.querySelectorAll('.row')).map((r) => ({
      time: (r.querySelector('.time') || {}).textContent || '',
      label: (r.querySelector('.label') || {}).textContent || '',
      status: Array.from(r.querySelectorAll('.chip')).map((c) => c.textContent.replace(/\s+/g, ' ').trim()).join(' / '),
      detail: (r.querySelector('.spots') || {}).textContent || '',
      star: r.querySelector('.take') ? r.querySelector('.take').getAttribute('aria-pressed') : null,
    })),
  })));
}
const flat = (days) => [].concat.apply([], days.map((d) => d.trips.map((t) => Object.assign({ day: d.day }, t))));
async function pickProfile(page, initials) {
  await page.click('#meBtn');
  await page.locator('#who button', { hasText: initials }).click();
}
async function waitPut(gh, n = 1, ms = 5000) {
  const t0 = Date.now();
  while (gh.puts.length < n) { if (Date.now() - t0 > ms) throw new Error('no save reached GitHub (' + gh.puts.length + ' of ' + n + ')'); await sleep(50); }
  return gh.lastPut().json;
}
async function msg(page) { return (await page.textContent('#upMsg')) + ' ' + (await page.textContent('#keyMsg')); }
async function openEditor(server, opts = {}) {
  return open(server, Object.assign({ now: NOW, hash: '#edit', storage: withKey(opts.storage) }, opts, { storage: withKey(opts.storage) }));
}
async function editTrip(page, timeText, labelText) {
  const row = page.locator('.row', { hasText: timeText }).filter(labelText ? { hasText: labelText } : {}).first();
  await row.locator('.editbtn').click();
  return page.locator('.row.open');
}

// ---------------------------------------------------------------- viewer
test('viewer: upcoming trips by day; past trips hidden; Today and Tomorrow marked', async (s) => {
  const o = await open(s, { now: NOW });
  const days = await listed(o.page);
  eq(days.map((d) => d.day), ['Today, Monday, Oct 19', 'Tomorrow, Tuesday, Oct 20', 'Wednesday, Oct 21', 'Thursday, Oct 22', 'Saturday, Oct 24', 'Thursday, Jan 14, 2027'], 'day headings');
  eq(o.errors, [], 'page errors');
  await o.close();
}, { kind: 'ui' });

test('viewer: times on a 12-hour clock, no time = Time TBD, sorted with TBD last', async (s) => {
  const d = sampleData();
  d.trips.push({ date: '2026-10-19', time: '', status: 'Pending' }, { date: '2026-10-19', time: '00:15', status: 'Assigned' }, { date: '2026-10-19', time: '12:05', status: 'Assigned' });
  const o = await open(s, { now: NOW, data: d });
  const today = (await listed(o.page))[0].trips.map((t) => t.time);
  eq(today, ['12:15 AM', '10:00 AM', '12:05 PM', '1:30 PM', 'Time TBD']);
  await o.close();
});

test('viewer: a tag shows under its time; requesters see no counts or Pending only', async (s) => {
  const o = await open(s, { now: NOW });
  const t = flat(await listed(o.page));
  eq(t.filter((x) => x.label).map((x) => x.label), ['Group A', 'Lunch outing', 'Fall trip']);
  assert(await o.page.isHidden('#f-pending'), 'Pending only hidden');
  assert(await o.page.isHidden('#sum'), 'counts hidden');
  await o.close();
});

test('viewer: a trip with several drivers shows one overall status and how many drivers are set', async (s) => {
  const o = await open(s, { now: NOW });
  const t = flat(await listed(o.page));
  const fall = t.find((x) => x.label === 'Fall trip'), two = t.find((x) => x.day.includes('Oct 24'));
  eq([fall.status, fall.detail], ['Pending', '1 of 2 drivers assigned']);
  eq([two.status, two.detail], ['Assigned', '2 drivers']);
  await o.close();
}, { kind: 'ui' });

test('viewer: the Updated line shows when the list last changed', async (s) => {
  const o = await open(s, { now: NOW });
  eq(await o.page.textContent('#updated'), 'Updated Oct 19, 8:30 AM');
  await o.close();
});

test('viewer: broken entries in trips.json are skipped instead of breaking the page', async (s) => {
  const d = sampleData();
  d.trips.push({ time: '10:00', status: 'Pending' }, { date: '2026-10-20', time: 'soon', status: 'Pending' }, { date: '2026-10-20', time: '11:00', status: 'Maybe', who: 'x', drivers: 'y' }, null, 'junk');
  d.profiles.push({ id: 5 }, null);
  const o = await open(s, { now: NOW, data: d });
  const t = flat(await listed(o.page));
  assert(t.length >= 7, 'the good trips still show (' + t.length + ')');
  eq(o.errors, [], 'page errors');
  await o.close();
});

test('viewer: an impossible date is never shown on another day', async (s) => {
  const d = sampleData();
  d.trips.push({ date: '2026-11-31', time: '10:00', status: 'Pending', label: 'Bad date' });
  const o = await open(s, { now: NOW, data: d });
  const t = flat(await listed(o.page));
  assert(!t.some((x) => x.label === 'Bad date'), 'Nov 31 trip should not appear as Dec 1');
  await o.close();
});

test('viewer: offline start shows the last list with a no-connection note', async (s) => {
  const gh = new FakeGitHub(sampleData());
  const o = await open(s, { now: NOW, gh });
  gh.pagesFail = true;
  await o.page.reload();
  await o.page.waitForFunction(() => document.getElementById('warn').textContent);
  assert(/No connection/i.test(await o.page.textContent('#warn')), 'warning text');
  assert(flat(await listed(o.page)).length === 7, 'cached list shows');
  await o.close();
});

test('viewer: a slow earlier check never overwrites a newer list', async (s) => {
  const oldD = sampleData(), newD = sampleData();
  newD.trips.find((t) => t.label === 'Fall trip').drivers = ['Assigned', 'Assigned'];
  newD.trips.find((t) => t.label === 'Fall trip').status = 'Assigned';
  newD.updated = '2026-10-19T12:45:00.000Z';
  const gh = new FakeGitHub(oldD);
  const o = await open(s, { now: NOW, gh });
  gh.pagesQueue.push({ delay: 1500, body: JSON.stringify(oldD) }, { body: JSON.stringify(newD) });
  await o.page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(100);
  await o.page.click('#refresh');
  await sleep(2200);
  const fall = flat(await listed(o.page)).find((x) => x.label === 'Fall trip');
  eq(fall.status, 'Assigned', 'newest list kept');
  await o.close();
});

test('viewer: a background check with no changes leaves the page alone (keeps focus and place)', async (s) => {
  const o = await open(s, { now: NOW });
  await o.page.evaluate(() => { document.querySelector('#days .row').setAttribute('data-marker', '1'); });
  await o.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(500);
  assert(await o.page.$('#days .row[data-marker]'), 'list was redrawn although nothing changed');
  await o.close();
});

test('viewer: dates show the year only when it is not this year', async (s) => {
  const o = await open(s, { now: NOW });
  const days = (await listed(o.page)).map((d) => d.day);
  assert(days.some((d) => /Jan 14, 2027/.test(d)), 'next year has its year: ' + days.join(' | '));
  assert(!days.some((d) => /Oct 2\d, 2026/.test(d)), 'this year has no year');
  await o.close();
}, { kind: 'ui' });

test('viewer: viewers never see editing controls', async (s) => {
  const o = await open(s, { now: NOW });
  eq(await o.page.$$eval('.editbtn, .row.open', (l) => l.length), 0, 'edit buttons');
  for (const id of ['#saveBar', '#upload', '#sum', '#f-pending']) assert(await o.page.isHidden(id), id + ' hidden');
  await o.close();
});

test('viewer: the bottom of the page says when the list last changed and when it was checked', async (s) => {
  const o = await open(s, { now: NOW });
  eq(await o.page.textContent('#updated'), 'Updated Oct 19, 8:30 AM');
  assert(/^Checked at 9:0\d AM$/.test(await o.page.textContent('#checked')), 'checked: ' + await o.page.textContent('#checked'));
  await o.close();
});

test('viewer: the header button says in words who is viewing', async (s) => {
  const o = await open(s, { now: NOW });
  eq((await o.page.textContent('#meBtn')).trim(), 'Choose profile');
  await pickProfile(o.page, 'Q.Z.');
  const t = (await o.page.textContent('#meBtn')).replace(/\s+/g, ' ').trim();
  assert(/Q\.Z\./.test(t) && /Change/.test(t), 'header button: ' + t);
  eq(await o.page.getAttribute('#meBtn', 'aria-label'), null, 'no hidden label that differs from the words');
  await o.close();
}, { kind: 'a11y' });

test('viewer: trips waiting for a driver stand out (dashed Pending chip and a bar on the row)', async (s) => {
  const o = await open(s, { now: NOW });
  const r = await o.page.$$eval('#days .row', (l) => l.map((row) => ({ pend: row.classList.contains('pend'), chip: row.querySelector('.chip').textContent.trim(), border: getComputedStyle(row.querySelector('.chip')).borderStyle })));
  r.forEach((x) => { eq(x.pend, /Pending/.test(x.chip), 'row mark for ' + x.chip); eq(x.border, /Pending/.test(x.chip) ? 'dashed' : 'solid', 'chip border for ' + x.chip); });
  await o.close();
}, { kind: 'ui' });

// ---------------------------------------------------------------- profiles and following
test('profile: made from a name, only initials kept, works at once, request sent', async (s) => {
  const o = await open(s, { now: NOW });
  await o.page.click('#meBtn');
  await o.page.click('#who [data-make]');
  await o.page.fill('#mFirst', 'Sample'); await o.page.fill('#mLast', 'Person');
  await o.page.locator('#mIcons button', { hasText: '🐢' }).click();
  await o.page.click('#mSend');
  await sleep(200);
  assert(/^Profile request: S\.P\. 🐢 p[a-z0-9]{6,20}$/.test(o.ntfy.posted[0] || ''), 'request: ' + o.ntfy.posted[0]);
  const store = await o.page.evaluate(() => JSON.stringify(localStorage));
  assert(!/Sample|Person/.test(store), 'name never stored');
  assert((await o.page.textContent('#meBtn')).includes('S.P.'), 'equipped');
  assert(await o.page.isVisible('#f-mine'), 'My trips shown');
  await o.close();
});

test('profile: accented names give the right initials', async (s) => {
  const o = await open(s, { now: NOW });
  await o.page.click('#meBtn'); await o.page.click('#who [data-make]');
  await o.page.fill('#mFirst', 'Émile'); await o.page.fill('#mLast', 'Ödegaard');
  await o.page.click('#mSend');
  await sleep(200);
  assert(/^Profile request: E\.O\. /.test(o.ntfy.posted[0] || ''), 'got ' + o.ntfy.posted[0]);
  await o.close();
});

test('profile: a name without letters A-Z is refused with a message', async (s) => {
  const o = await open(s, { now: NOW });
  await o.page.click('#meBtn'); await o.page.click('#who [data-make]');
  await o.page.fill('#mFirst', '李'); await o.page.fill('#mLast', '王');
  await o.page.click('#mSend');
  assert(/first and last name/i.test(await o.page.textContent('#mMsg')), 'message');
  eq(o.ntfy.posted.length, 0);
  await o.close();
});

test('follow: Follow on one of two same-time trips follows only that trip', async (s) => {
  const d = sampleData();
  d.trips.push({ date: '2026-10-20', time: '09:15', status: 'Pending', label: 'Zoo' });
  d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  d.trips.find((t) => t.date === '2026-10-20').label = 'Mall';
  const o = await open(s, { now: NOW, data: d });
  await pickProfile(o.page, 'Q.Z.');
  await o.page.click('#f-all');
  await o.page.locator('.row', { hasText: 'Zoo' }).locator('.take').click();
  const t = flat(await listed(o.page)).filter((x) => x.day.includes('Oct 20'));
  eq(t.map((x) => x.label + ':' + x.star), ['Mall:false', 'Zoo:true']);
  await o.page.click('#f-mine');
  eq(flat(await listed(o.page)).map((x) => x.label), ['Zoo']);
  await o.close();
});

test('follow: a followed trip stays followed when its time changes', async (s) => {
  const d = sampleData();
  d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  const gh = new FakeGitHub(d);
  const o = await open(s, { now: NOW, gh });
  await pickProfile(o.page, 'Q.Z.');
  await o.page.click('#f-all');
  await o.page.locator('.row', { hasText: 'Lunch outing' }).locator('.take').click();
  const d2 = JSON.parse(JSON.stringify(d)); d2.trips.find((t) => t.label === 'Lunch outing').time = '11:30'; d2.updated = '2026-10-19T13:00:00.000Z';
  gh.setRepo(d2); gh.publish();
  await o.page.click('#f-mine');
  await o.page.click('#refresh'); await sleep(600);
  eq(flat(await listed(o.page)).map((x) => x.time + ' ' + x.label), ['11:30 AM Lunch outing']);
  await o.close();
});

test('follow: tapping the star keeps focus on that star (screen readers and keyboards)', async (s) => {
  const o = await open(s, { now: NOW });
  await pickProfile(o.page, 'Q.Z.');
  await o.page.click('#f-all');
  const star = o.page.locator('.row', { hasText: 'Lunch outing' }).locator('.take');
  await star.focus();
  await o.page.keyboard.press('Enter');
  await sleep(100);
  const info = await o.page.evaluate(() => { const a = document.activeElement; return { cls: a.className, row: a.closest('.row') ? a.closest('.row').textContent : '' }; });
  assert(/take/.test(info.cls) && /Lunch outing/.test(info.row), 'focus went to ' + JSON.stringify(info));
  await o.close();
});

test('follow: each Follow button says which trip it follows, and Following once tapped', async (s) => {
  const o = await open(s, { now: NOW });
  await pickProfile(o.page, 'Q.Z.');
  await o.page.click('#f-all');
  const b = o.page.locator('.row', { hasText: 'Lunch outing' }).locator('.take');
  const name = (await b.textContent()).trim();
  assert(/^Follow the /.test(name) && /Wednesday, Oct 21/.test(name) && /Lunch outing/.test(name), 'name: ' + name);
  assert(!(await b.getAttribute('aria-label')), 'the name comes from the words on the button (so voice control matches it)');
  await b.click();
  assert(/^Following the /.test((await b.textContent()).trim()), 'says Following: ' + await b.textContent());
  eq(await b.getAttribute('aria-pressed'), 'true');
  await o.close();
}, { kind: 'a11y' });

test('profile: a profile that disappeared from the list falls back to Everyone', async (s) => {
  const o = await open(s, { now: NOW, storage: { 'trip-status-me': 'pgone12345', 'trips-filter': 'mine' } });
  eq(o.errors, []);
  assert(await o.page.isHidden('#f-mine'), 'My trips hidden');
  assert(flat(await listed(o.page)).length === 7, 'all trips shown');
  await o.close();
});

test('profile: a new profile switches to the shared copy and keeps follows', async (s) => {
  const d = sampleData();
  d.profiles.push({ id: 'pshared9999', initials: 'S.P.', icon: '🐢' });
  const o = await open(s, { now: NOW, data: d, storage: {
    'trip-status-mine': JSON.stringify([{ id: 'plocal12345', initials: 'S.P.', icon: '🐢' }]),
    'trip-status-me': 'plocal12345', 'trips-filter': 'mine',
    'trip-status-follow': JSON.stringify(['plocal12345|2026-10-21|TBD']),
  } });
  eq(flat(await listed(o.page)).map((x) => x.label), ['Lunch outing']);
  eq(await o.page.evaluate(() => localStorage.getItem('trip-status-me')), 'pshared9999');
  eq(await o.page.evaluate(() => localStorage.getItem('trip-status-mine')), '[]');
  await o.close();
});

test('profile: the Who is viewing panel lists people alphabetically', async (s) => {
  const d = sampleData();
  d.profiles = [{ id: 'pz', initials: 'Z.A.', icon: '🐝' }, { id: 'pa', initials: 'A.B.', icon: '🍎' }, { id: 'pm', initials: 'M.M.', icon: '🎵' }];
  const o = await open(s, { now: NOW, data: d });
  await o.page.click('#meBtn');
  const names = await o.page.$$eval('#who button[data-p]', (b) => b.map((x) => x.textContent.trim()));
  eq(names, ['👥Everyone', '🍎A.B.', '🎵M.M.', '🐝Z.A.']);
  await o.close();
}, { kind: 'ui' });

// ---------------------------------------------------------------- editing
test('editor: an editing link saves the key and takes it out of the address bar', async (s) => {
  const o = await open(s, { now: NOW, hash: '#edit=' + KEY });
  eq(await o.page.evaluate(() => localStorage.getItem('trip-status-key')), KEY);
  eq(await o.page.evaluate(() => location.hash), '#edit');
  assert(await o.page.isVisible('#add'), 'editing screen');
  await o.close();
});

test('editor: plain #edit asks for a key; a wrong key shows GitHub\'s reason; the whole link works', async (s) => {
  const o = await open(s, { now: NOW, hash: '#edit' });
  assert(await o.page.isVisible('#keyBox'), 'key box');
  await o.page.fill('#token', 'github_pat_WRONG'); await o.page.click('#saveToken');
  await o.page.waitForFunction(() => /does not recognize/.test(document.body.textContent));
  await o.page.fill('#token', 'https://jbrantner.github.io/trip-status/#edit=' + KEY); await o.page.click('#saveToken');
  await o.page.waitForSelector('#add', { state: 'visible' });
  eq(await o.page.evaluate(() => localStorage.getItem('trip-status-key')), KEY);
  await o.close();
});

test('editor: edit time, tag and driver spots, then Save writes only the allowed fields', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input[type=time]').fill('14:45');
  await f.locator('input.lbl').fill('Picnic');
  await f.locator('.addslot').click();
  await o.page.locator('.row.open .slotrow').nth(0).locator('button', { hasText: 'Assigned' }).click();
  await o.page.locator('.row.open .done').click();
  await o.page.click('#publish');
  const j = await waitPut(o.gh);
  const t = j.trips.find((x) => x.label === 'Picnic');
  eq({ date: t.date, time: t.time, status: t.status, drivers: t.drivers }, { date: '2026-10-19', time: '14:45', status: 'Pending', drivers: ['Assigned', 'Pending'] });
  assert(!j.trips.some((x) => x.date < '2026-10-19'), 'past trips dropped');
  const allowed = ['date', 'time', 'status', 'label', 'drivers', 'who', 'id'];
  j.trips.forEach((x) => Object.keys(x).forEach((k) => assert(allowed.includes(k), 'unexpected key ' + k)));
  eq(Object.keys(j).sort(), ['profiles', 'trips', 'updated']);
  await o.close();
});

test('editor: typing is not lost when the list checks for changes in the background', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').click();
  await o.page.keyboard.type('Half typ');
  await o.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(600);
  const v = await o.page.$eval('.row.open input.lbl', (i) => i.value).catch(() => null);
  eq(v, 'Half typ', 'tag box after a background check');
  await o.close();
});

test('editor: Save keeps a profile the automatic job added meanwhile', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('.seg button', { hasText: 'Assigned' }).click();
  await o.page.locator('.row.open .done').click();
  const r = o.gh.repoJson(); r.profiles.push({ id: 'pnew0001', initials: 'N.W.', icon: '🌙' }); o.gh.setRepo(r);
  await o.page.click('#publish');
  const j = await waitPut(o.gh);
  assert(j.profiles.some((p) => p.initials === 'N.W.'), 'profile kept: ' + JSON.stringify(j.profiles));
  assert(j.trips.find((t) => t.date === '2026-10-19' && t.time === '13:30').status === 'Assigned', 'own change saved');
  await o.close();
});

test('editor: Save keeps a trip change made on another device meanwhile', async (s) => {
  const d = sampleData(); d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  const o = await openEditor(s, { data: d });
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('Mine');
  await o.page.locator('.row.open .done').click();
  const r = o.gh.repoJson(); r.trips.find((t) => t.date === '2026-10-20').status = 'Pending'; r.trips.find((t) => t.date === '2026-10-20').label = 'Theirs'; o.gh.setRepo(r);
  await o.page.click('#publish');
  const j = await waitPut(o.gh);
  eq(j.trips.find((t) => t.date === '2026-10-19' && t.time === '13:30').label, 'Mine');
  eq(j.trips.find((t) => t.date === '2026-10-20').label, 'Theirs');
  await o.close();
});

test('editor: Save tries again by itself when GitHub says the file just changed', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('Retry');
  await o.page.locator('.row.open .done').click();
  o.gh.putQueue.push({ status: 409 });
  await o.page.click('#publish');
  const j = await waitPut(o.gh, 1, 8000);
  assert(j.trips.some((t) => t.label === 'Retry'), 'saved after retry');
  await o.close();
});

test('editor: a key GitHub no longer accepts says so and offers to enter a new key', async (s) => {
  const o = await openEditor(s, { gh: { tokens: { 'github_pat_GOOD': undefined } } });
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('X');
  await o.page.locator('.row.open .done').click();
  await o.page.click('#publish');
  await o.page.waitForFunction(() => /does not recognize/.test(document.getElementById('upMsg').textContent));
  assert(await o.page.isVisible('#keyBox') || await o.page.isVisible('#newKey'), 'a way to enter a new key is right there');
  await o.close();
}, { kind: 'ui' });

test('editor: Remove trip can be undone before saving', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('.rm').click();
  assert(!flat(await listed(o.page)).some((x) => x.time === '1:30 PM'), 'removed');
  await o.page.click('#undo');
  assert(flat(await listed(o.page)).some((x) => x.time === '1:30 PM'), 'back after Undo');
  await o.close();
}, { kind: 'ui' });

test('editor: boxes use 16px text or more so iPhones do not zoom in', async (s) => {
  const o = await openEditor(s);
  await editTrip(o.page, '1:30 PM');
  const sizes = await o.page.$$eval('input', (l) => l.filter((i) => i.offsetParent).map((i) => parseFloat(getComputedStyle(i).fontSize)));
  assert(sizes.length && sizes.every((x) => x >= 16), 'font sizes ' + sizes.join(', '));
  await o.close();
});

test('editor: Pending and Assigned buttons tell screen readers which is chosen', async (s) => {
  const o = await openEditor(s);
  await editTrip(o.page, '1:30 PM');
  const st = await o.page.$$eval('.row.open .seg button', (b) => b.map((x) => x.textContent + ':' + x.getAttribute('aria-pressed')));
  eq(st, ['Pending:true', 'Assigned:false']);
  await o.close();
});

test('editor: the Updated line keeps the published time until Save', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('Y');
  await o.page.locator('.row.open .done').click();
  eq(await o.page.textContent('#updated'), 'Updated Oct 19, 8:30 AM');
  await o.close();
});

test('editor: Refresh checks again right after a save', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('Z');
  await o.page.locator('.row.open .done').click();
  await o.page.click('#publish'); await waitPut(o.gh);
  let n = 0; o.page.on('request', (r) => { if (/trips\.json/.test(r.url())) n++; });
  await o.page.click('#refresh'); await sleep(500);
  assert(n >= 1, 'Refresh fetched the list');
  await o.close();
});

test('editor: + Add trip, set a time, Save', async (s) => {
  const o = await openEditor(s);
  await o.page.click('#add');
  const f = o.page.locator('.row.open');
  await f.locator('input[type=date]').fill('2026-10-23');
  await f.locator('input[type=time]').fill('07:05');
  await f.locator('.done').click();
  await o.page.click('#publish');
  const j = await waitPut(o.gh);
  assert(j.trips.some((t) => t.date === '2026-10-23' && t.time === '07:05' && t.status === 'Pending'), 'new trip saved');
  await o.close();
});

test('editor: Requested by chips toggle and show who on the trip', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  const chip = f.locator('.assign .pchip', { hasText: 'Q.Z.' });
  await chip.click();
  eq(await o.page.locator('.row.open .assign .pchip', { hasText: 'Q.Z.' }).getAttribute('aria-pressed'), 'true');
  await o.page.locator('.row.open .done').click();
  await o.page.click('#publish');
  const j = await waitPut(o.gh);
  eq(j.trips.find((t) => t.time === '13:30').who, ['pq1zz0001']);
  await o.close();
});

test('editor: removing a profile takes it off every trip', async (s) => {
  const d = sampleData(); d.trips[2].who = ['pq1zz0001', 'pxy00002'];
  const o = await openEditor(s, { data: d });
  await o.page.click('details.more summary');
  await o.page.click('#plist button[data-p="pq1zz0001"]');
  await o.page.click('#publish');
  const j = await waitPut(o.gh);
  eq(j.profiles.map((p) => p.id), ['pxy00002']);
  eq(j.trips.find((t) => t.time === '13:30').who, ['pxy00002']);
  await o.close();
});

test('editor: Use a different key forgets the key on this device', async (s) => {
  const o = await openEditor(s);
  await o.page.click('details.more summary');
  await o.page.click('#forget');
  assert(await o.page.isVisible('#keyBox'), 'asks for a key');
  eq(await o.page.evaluate(() => localStorage.getItem('trip-status-key')), null);
  await o.close();
});

test('editor: Copy editing link copies a link with the key', async (s) => {
  const o = await openEditor(s, { context: { permissions: ['clipboard-read', 'clipboard-write'] } });
  await o.page.click('details.more summary');
  await o.page.click('#copyLink');
  await sleep(200);
  const c = await o.page.evaluate(() => navigator.clipboard.readText());
  assert(c.endsWith('/trip-status/#edit=' + KEY), c);
  await o.close();
});

test('editor: a trip date cannot be set before today', async (s) => {
  const o = await openEditor(s);
  await editTrip(o.page, '1:30 PM');
  eq(await o.page.getAttribute('.row.open input[type=date]', 'min'), '2026-10-19');
  await o.close();
}, { kind: 'ui' });

test('editor: opening with ?editor (installed Trip Editor) uses the editor manifest', async (s) => {
  const o = await open(s, { now: NOW, path: '?editor', storage: withKey() });
  assert((await o.page.getAttribute('link[rel=manifest]', 'href')).includes('manifest-edit'), 'editor manifest');
  eq(await o.page.evaluate(() => location.hash), '#edit');
  await o.close();
  const v = await open(s, { now: NOW });
  assert(!(await v.page.getAttribute('link[rel=manifest]', 'href')).includes('edit'), 'viewer manifest');
  await v.close();
});

test('editor: counts at the top, and Pending only shows just the trips without a driver', async (s) => {
  const o = await openEditor(s);
  eq((await o.page.textContent('#sum')).replace(/\s+/g, ' ').trim(), '3 Pending 4 Assigned');
  await o.page.click('#f-pending');
  eq(flat(await listed(o.page)).map((x) => x.time + ' ' + x.status), ['1:30 PM Pending', 'Time TBD Pending', '9:45 AM Pending']);
  await o.close();
});

test('editor: the viewing and editing screens each remember their own filter', async (s) => {
  // Someone who uses My trips on the viewing screen still sees every trip when the editing screen opens.
  const o = await openEditor(s, { storage: { 'trip-status-me': 'pq1zz0001', 'trips-filter': 'mine' } });
  eq(await o.page.getAttribute('#f-all', 'aria-pressed'), 'true');
  eq((await o.page.$$('.row')).length, 7);
  await o.page.click('#f-pending');
  await o.page.evaluate(() => { location.hash = '#view'; });
  await o.page.waitForFunction(() => document.getElementById('f-mine').getAttribute('aria-pressed') === 'true');
  await o.page.evaluate(() => { location.hash = '#edit'; });
  await o.page.waitForFunction(() => document.getElementById('f-pending').getAttribute('aria-pressed') === 'true');
  eq((await o.page.$$('.row')).length, 3);
  await o.close();
});

test('editor: the first tap after typing is not lost', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('Quick');
  await f.locator('.seg button', { hasText: 'Assigned' }).click(); // straight from the box, no tap elsewhere first
  eq(await o.page.locator('.row.open .seg button', { hasText: 'Assigned' }).getAttribute('aria-pressed'), 'true');
  eq(await o.page.$eval('.row.open input.lbl', (i) => i.value), 'Quick');
  await o.page.locator('.row.open .done').click();
  await o.page.click('#publish');
  const t = (await waitPut(o.gh)).trips.find((x) => x.time === '13:30');
  eq([t.label, t.status], ['Quick', 'Assigned']);
  await o.close();
});

test('editor: a background check never replaces the trip being edited, and Done shows what changed meanwhile', async (s) => {
  const d = sampleData(); d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  const gh = new FakeGitHub(d);
  const o = await openEditor(s, { gh });
  await editTrip(o.page, '1:30 PM');
  await o.page.evaluate(() => { document.querySelector('.row.open input.lbl').__mark = 1; });
  const d2 = JSON.parse(JSON.stringify(d)); d2.trips.find((t) => t.date === '2026-10-20').label = 'From elsewhere'; d2.updated = '2026-10-19T13:20:00.000Z';
  gh.setRepo(d2); gh.publish();
  await o.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(600);
  eq(await o.page.$eval('.row.open input.lbl', (i) => i.__mark || 0), 1, 'the open trip\'s boxes were not replaced');
  await o.page.locator('.row.open .done').click();
  assert(flat(await listed(o.page)).some((x) => x.label === 'From elsewhere'), 'Done shows the newer list');
  await o.close();
});

test('editor: a failed save is said at once (an alert), and a later Saved replaces it', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input.lbl').fill('A');
  await o.page.locator('.row.open .done').click();
  o.gh.apiFail = true;
  await o.page.click('#publish');
  await o.page.waitForFunction(() => document.getElementById('upBad').textContent);
  assert(/Could not reach GitHub/.test(await o.page.textContent('#upBad')), await o.page.textContent('#upBad'));
  eq(await o.page.textContent('#upOk'), '');
  o.gh.apiFail = false;
  await o.page.click('#publish');
  await waitPut(o.gh);
  await o.page.waitForFunction(() => /Saved/.test(document.getElementById('upOk').textContent));
  eq(await o.page.textContent('#upBad'), '', 'the old problem is gone');
  await o.close();
}, { kind: 'a11y' });

test('editor: a trip with no date stays open, and Save asks for the date instead of hiding the trip', async (s) => {
  const o = await openEditor(s);
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('input[type=date]').fill('');
  await f.locator('.done').click();
  assert(await o.page.isVisible('.row.open'), 'still open after Done');
  assert(/Pick a date/.test(await o.page.textContent('#upBad')), 'asks for a date');
  await o.page.click('#publish');
  assert(await o.page.isVisible('.row.open input[type=date]'), 'still open after Save');
  eq(o.gh.puts.length, 0, 'nothing saved');
  await o.page.locator('.row.open input[type=date]').fill('2026-10-23');
  await o.page.click('#publish');
  assert((await waitPut(o.gh)).trips.some((t) => t.date === '2026-10-23' && t.time === '13:30'), 'saved with the new date');
  await o.close();
});

test('editor: after a key is connected, the key box no longer says Checking', async (s) => {
  const o = await open(s, { now: NOW, hash: '#edit' });
  await o.page.fill('#token', KEY); await o.page.click('#saveToken');
  await o.page.waitForSelector('#add', { state: 'visible' });
  eq((await o.page.textContent('#keyMsg')).trim(), '');
  await o.close();
});

// ---------------------------------------------------------------- Helper's Update link
const helperExport = (trips) => ({ app: 'trip-status', exported: '2026-10-19T13:00:00Z', trips });

test('helper: an Update saves for everyone and the tab closes itself', async (s) => {
  const ex = helperExport([{ date: '2026-10-18', time: '08:00', status: 'Assigned' }, { date: '2026-10-19', time: '10:00', status: 'Assigned' }, { date: '2026-10-21', time: '', status: 'Assigned' }, { date: '2026-10-22', time: '09:45', status: 'Pending', drivers: ['Assigned', 'Pending'] }]);
  const gh = new FakeGitHub(sampleData());
  const o = await open(s, { now: NOW, gh, hash: helperHash(ex), storage: withKey(), wait: false });
  const j = await waitPut(gh);
  eq(j.trips.map((t) => [t.date, t.time, t.status, t.label || '', (t.drivers || []).join('+')]),
    [['2026-10-19', '10:00', 'Assigned', 'Group A', ''], ['2026-10-21', '', 'Assigned', 'Lunch outing', ''], ['2026-10-22', '09:45', 'Pending', 'Fall trip', 'Assigned+Pending']]);
  await o.page.waitForFunction(() => window.__closed === true, null, { timeout: 4000 });
  eq(await o.page.evaluate(() => location.hash), '#edit');
  await o.close();
});

test('helper: same-time trips keep their own tags and requesters', async (s) => {
  const d = sampleData();
  d.trips = [{ date: '2026-12-12', time: '08:30', status: 'Pending', label: 'Zoo', who: ['pq1zz0001'] }, { date: '2026-12-12', time: '08:30', status: 'Pending', label: 'Mall', who: ['pxy00002'] }];
  const ex = helperExport([{ date: '2026-12-12', time: '08:30', status: 'Assigned' }, { date: '2026-12-12', time: '08:30', status: 'Pending' }]);
  const o = await open(s, { now: NOW, data: d, hash: helperHash(ex), storage: withKey(), wait: false });
  const j = await waitPut(o.gh);
  eq(j.trips.map((t) => t.status + ':' + (t.label || '') + ':' + (t.who || []).join()), ['Assigned:Zoo:pq1zz0001', 'Pending:Mall:pxy00002']);
  await o.close();
});

test('helper: a tag from Helper replaces the one on the site; a blank one keeps it', async (s) => {
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Assigned', label: 'New tag' }, { date: '2026-10-21', time: '', status: 'Pending' }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: withKey(), wait: false });
  const j = await waitPut(o.gh);
  eq(j.trips.map((t) => t.label), ['New tag', 'Lunch outing']);
  await o.close();
});

test('helper: an Update with any extra information is refused and nothing is saved', async (s) => {
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Assigned', driver: 'Someone' }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: withKey(), wait: false });
  await o.page.waitForFunction(() => /extra information/.test(document.getElementById('upMsg').textContent));
  await sleep(300);
  eq(o.gh.puts.length, 0);
  await o.close();
});

test('helper: a tag over 30 characters is refused', async (s) => {
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Assigned', label: 'x'.repeat(31) }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: withKey(), wait: false });
  await o.page.waitForFunction(() => /30/.test(document.getElementById('upMsg').textContent));
  eq(o.gh.puts.length, 0);
  await o.close();
});

test('helper: tags with accents, emoji, quotes and HTML round-trip safely', async (s) => {
  const tag = 'Café ☕ "A" <b>&</b> ünï';
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Assigned', label: tag }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: withKey(), wait: false });
  const j = await waitPut(o.gh);
  eq(j.trips[0].label, tag);
  await o.page.waitForSelector('.row .label');
  eq(await o.page.textContent('.row .label'), tag);
  assert(!(await o.page.$('.row .label b')), 'no HTML from a tag');
  await o.close();
});

test('helper: on a device without the key it asks once, then applies the Update', async (s) => {
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Pending' }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), wait: false });
  await o.page.waitForSelector('#keyBox', { state: 'visible' });
  await o.page.fill('#token', KEY); await o.page.click('#saveToken');
  const j = await waitPut(o.gh);
  eq(j.trips.map((t) => t.status), ['Pending']);
  await o.close();
});

test('helper: when GitHub refuses, the tab stays open and says why', async (s) => {
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Pending' }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: { 'trip-status-key': 'github_pat_READONLY' }, wait: false });
  await o.page.waitForFunction(() => /cannot change trip-status/.test(document.getElementById('upMsg').textContent), null, { timeout: 5000 });
  await sleep(2000);
  assert(!(await o.page.evaluate(() => window.__closed)), 'tab stayed open');
  await o.close();
});

test('helper: two Updates at once both save (the second tries again)', async (s) => {
  const gh = new FakeGitHub(sampleData());
  const ex1 = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Pending' }]);
  const ex2 = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Assigned' }]);
  const o = await open(s, { now: NOW, gh, hash: helperHash(ex1), storage: withKey(), wait: false });
  const p2 = await o.ctx.newPage();
  await p2.clock.install({ time: new Date(NOW) });
  await p2.goto(s.url + helperHash(ex2));
  await waitPut(gh, 2, 9000);
  await o.close();
});

test('helper: an unreadable Update link says so', async (s) => {
  const o = await open(s, { now: NOW, hash: '#helper=bm90IGpzb24', storage: withKey(), wait: false });
  await o.page.waitForFunction(() => /could not be read/.test(document.getElementById('upMsg').textContent));
  eq(o.gh.puts.length, 0);
  await o.close();
});

test('helper: an Update with an impossible date is refused, not shown on another day', async (s) => {
  const ex = helperExport([{ date: '2026-11-31', time: '10:00', status: 'Pending' }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: withKey(), wait: false });
  await o.page.waitForFunction(() => /date/.test(document.getElementById('upMsg').textContent));
  eq(o.gh.puts.length, 0);
  await o.close();
});

test('helper: a trip Helper calls Pending stays Pending even when every driver spot is filled', async (s) => {
  const ex = helperExport([{ date: '2026-10-22', time: '09:45', status: 'Pending', drivers: ['Assigned', 'Assigned'] }, { date: '2026-10-24', time: '08:30', status: 'Assigned', drivers: ['Assigned', 'Assigned'] }]);
  const o = await open(s, { now: NOW, hash: helperHash(ex), storage: withKey(), wait: false });
  const j = await waitPut(o.gh);
  eq(j.trips.map((t) => [t.date, t.status, (t.drivers || []).join('+')]), [['2026-10-22', 'Pending', ''], ['2026-10-24', 'Assigned', 'Assigned+Assigned']]);
  await o.close();
});

test('helper: an older Update never replaces a newer one that was saved first', async (s) => {
  const d = sampleData(); d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); }); d.helperAt = '2026-10-19T13:05:00Z';
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Pending' }]); ex.exported = '2026-10-19T13:00:00Z';
  const o = await open(s, { now: NOW, data: d, hash: helperHash(ex), storage: withKey(), wait: false });
  await o.page.waitForFunction(() => /newer update from Helper/.test(document.getElementById('upMsg').textContent), null, { timeout: 5000 });
  eq(o.gh.puts.length, 0, 'nothing written');
  await o.page.waitForFunction(() => window.__closed === true, null, { timeout: 4000 });
  await o.close();
});

test('helper: an Update that has to try again goes onto the newest list (Helper wins on trips, the rest is kept)', async (s) => {
  const d = sampleData(); d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Assigned' }, { date: '2026-10-19', time: '13:30', status: 'Assigned' }]);
  ex.exported = '2026-10-19T13:10:00Z';
  const gh = new FakeGitHub(d);
  // Just before the first write lands, another device changes the list: an older Helper Update set 1:30 PM back to
  // Pending, and someone added a requester and a profile.
  gh.putQueue.push({ status: 409, beforeWrite: (g) => {
    const r = g.repoJson(); r.helperAt = '2026-10-19T13:00:00Z';
    r.trips.find((t) => t.time === '13:30').status = 'Pending';
    r.trips.find((t) => t.time === '10:00' && t.date === '2026-10-19').who = ['pxy00002'];
    r.profiles.push({ id: 'pnew0001', initials: 'N.W.', icon: '🌙' });
    g.setRepo(r);
  } });
  const o = await open(s, { now: NOW, gh, hash: helperHash(ex), storage: withKey(), wait: false });
  const j = await waitPut(gh, 1, 8000);
  eq(j.trips.map((t) => [t.time, t.status, t.label || '', (t.who || []).join()]), [['10:00', 'Assigned', 'Group A', 'pxy00002'], ['13:30', 'Assigned', '', '']]);
  assert(j.profiles.some((p) => p.id === 'pnew0001'), 'profile kept');
  eq(j.helperAt, '2026-10-19T13:10:00Z');
  await o.close();
});

test('helper: with no connection it says nothing was saved', async (s) => {
  const gh = new FakeGitHub(sampleData()); gh.pagesFail = true; gh.apiFail = true;
  const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Pending' }]);
  const o = await open(s, { now: NOW, gh, hash: helperHash(ex), storage: withKey(), wait: false });
  await o.page.waitForFunction(() => /nothing was saved/.test(document.body.textContent), null, { timeout: 5000 });
  assert(!(await o.page.evaluate(() => window.__closed)), 'tab stays open');
  await o.close();
});

test('helper: 300 trips is fine, 301 is refused', async (s) => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ date: '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), time: String(6 + (i % 12)).padStart(2, '0') + ':00', status: i % 3 ? 'Assigned' : 'Pending' }));
  const o = await open(s, { now: NOW, hash: helperHash(helperExport(many(300))), storage: withKey(), wait: false });
  const j = await waitPut(o.gh);
  eq(j.trips.length, 300);
  await o.close();
  const o2 = await open(s, { now: NOW, hash: helperHash(helperExport(many(301))), storage: withKey(), wait: false });
  await o2.page.waitForFunction(() => /too many/.test(document.getElementById('upMsg').textContent));
  eq(o2.gh.puts.length, 0);
  await o2.close();
});

// The real Helper: when HELPER_HTML points at Helper.html, its own Update button builds the link.
test('helper: round trip from Helper\'s own Update button', async (s) => {
  const file = process.env.HELPER_HTML;
  if (!file || !fs.existsSync(file)) { console.log('       (skipped: set HELPER_HTML to Helper.html to run it)'); return; }
  const b = await H.getBrowser();
  const hctx = await b.newContext({ timezoneId: 'America/New_York' });
  await hctx.route(/^https?:/, (r) => r.abort());
  const hp = await hctx.newPage();
  await hp.clock.install({ time: new Date(NOW) });
  await hp.goto('file://' + path.resolve(file));
  const url = await hp.evaluate(() => {
    /* Made-up trips in Helper's own format: [date, minutes, time text, DRIVER cell, place, back, riders, vehicle, extra] */
    trips = { file: 'made-up.xlsx', list: [
      ['2026-10-18', 600, '10:00 AM', 'Driver A', 'Sample Park', '', '4', '', { s: 600, e: 720, wc: false, wk: false, id: '1' }],
      ['2026-10-19', 600, '10:00 AM', 'Driver A', 'Sample Park', '12:00 PM', '4', '', { s: 600, e: 720, wc: false, wk: false, id: '2' }],
      ['2026-10-20', 555, '9:15 AM', '(Driver B)', 'Sample Museum', '', '6', '', { s: 555, e: 700, wc: false, wk: false, id: '3' }],
      ['2026-10-21', null, '', '', 'Sample Diner', '', '3', '', { s: null, e: null, wc: false, wk: false, id: '4' }],
      ['2026-10-22', 585, '9:45 AM', 'Driver A, (Driver B)', 'Sample Gardens', '', '12', '', { s: 585, e: 900, wc: false, wk: false, id: '5' }],
      ['2026-12-12', 510, '8:30 AM', 'Driver C', 'Sample Zoo', '', '5', '', { s: 510, e: 800, wc: false, wk: false, id: '6' }],
      ['2026-12-12', 510, '8:30 AM', '', 'Sample Mall', '', '5', '', { s: 510, e: 800, wc: false, wk: false, id: '7' }],
    ] };
    tripTags[tripKey(trips.list[4])] = 'Gardens ☘ "fall"';
    let opened = null; window.open = (u) => { opened = u; return null; };
    document.getElementById('trUpdate').onclick();
    return opened;
  });
  await hctx.close();
  assert(url && url.startsWith('https://jbrantner.github.io/trip-status/#helper='), 'Helper opened ' + url);
  const d = sampleData();
  d.trips = [{ date: '2026-12-12', time: '08:30', status: 'Pending', label: 'Zoo', who: ['pq1zz0001'] }, { date: '2026-12-12', time: '08:30', status: 'Pending', label: 'Mall' }];
  const o = await open(s, { now: NOW, data: d, hash: url.slice(url.indexOf('#')), storage: withKey(), wait: false });
  const j = await waitPut(o.gh);
  eq(j.trips.map((t) => [t.date, t.time, t.status, t.label || '', (t.drivers || []).join('+'), (t.who || []).join()]), [
    ['2026-10-19', '10:00', 'Assigned', '', '', ''],
    ['2026-10-20', '09:15', 'Pending', '', '', ''],
    ['2026-10-21', '', 'Pending', '', '', ''],
    ['2026-10-22', '09:45', 'Pending', 'Gardens ☘ "fall"', 'Assigned+Pending', ''],
    ['2026-12-12', '08:30', 'Assigned', 'Zoo', '', 'pq1zz0001'],
    ['2026-12-12', '08:30', 'Pending', 'Mall', '', ''],
  ]);
  await o.close();
});

// ---------------------------------------------------------------- preview page
test('preview: with made-up trips it never contacts GitHub or ntfy, and Save stays on the page', async (s) => {
  const d = sampleData(); d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  const o = await open(s, { now: NOW, hash: '#edit', init: 'window.TRIPS_PREVIEW = ' + JSON.stringify(d) });
  eq(flat(await listed(o.page)).length, 7, 'made-up trips show');
  const f = await editTrip(o.page, '1:30 PM');
  await f.locator('.seg button', { hasText: 'Assigned' }).click();
  await o.page.locator('.row.open .done').click();
  await o.page.click('#publish');
  await o.page.waitForFunction(() => /preview only/.test(document.getElementById('upOk').textContent));
  assert(flat(await listed(o.page)).find((x) => x.time === '1:30 PM').status === 'Assigned', 'the change shows');
  await o.page.click('#meBtn'); await o.page.click('#who [data-make]');
  await o.page.fill('#mFirst', 'Sample'); await o.page.fill('#mLast', 'Person'); await o.page.click('#mSend');
  eq([o.gh.pagesGets, o.gh.gets, o.gh.puts.length, o.gh.repoChecks, o.ntfy.posted.length], [0, 0, 0, 0, 0], 'requests to trips.json, GitHub and ntfy');
  assert(await o.page.isHidden('#shareBox'), 'no editing link to copy in a preview');
  await o.close();
});

// ---------------------------------------------------------------- offline copy (sw.js)
// Here the page's requests go through sw.js to a real local server (Playwright's stand-ins can't see them), so the
// site is served from a temporary copy with made-up trips.
async function withOfflineCopy(fn) {
  const site = siteCopy(sampleData()), srv = await startServer(site.dir);
  const o = await open(srv, { now: NOW, serviceWorkers: 'allow' });
  try {
    await o.page.evaluate(() => navigator.serviceWorker.ready);
    await o.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 5000 });
    await fn(o, srv, site);
  } finally { await o.close(); await srv.close(); site.remove(); }
}

test('offline copy: after one visit the app opens with no connection and says so', async () => {
  await withOfflineCopy(async (o, srv) => {
    srv.down = true;
    await o.page.reload();
    await o.page.waitForFunction(() => document.getElementById('warn').textContent, null, { timeout: 8000 });
    assert(/^No connection\. Showing the list from Oct 19, 8:30 AM/.test(await o.page.textContent('#warn')), await o.page.textContent('#warn'));
    eq(flat(await listed(o.page)).length, 7, 'trips from the saved copy');
    srv.down = false;
    await o.page.click('#refresh');
    await o.page.waitForFunction(() => !document.getElementById('warn').textContent, null, { timeout: 8000 });
  });
});

test('offline copy: a very slow connection shows the saved list after a few seconds', async () => {
  await withOfflineCopy(async (o, srv, site) => {
    const d = sampleData(); d.updated = '2026-10-19T13:30:00.000Z'; site.write(d);
    srv.slowMs = 9000;
    await o.page.click('#refresh');
    await o.page.waitForFunction(() => /Slow connection/.test(document.getElementById('warn').textContent), null, { timeout: 9000 });
    eq(await o.page.textContent('#updated'), 'Updated Oct 19, 8:30 AM', 'the saved list for now');
    await sleep(3500);
    await o.page.click('#refresh');
    await o.page.waitForFunction(() => /9:30 AM/.test(document.getElementById('updated').textContent), null, { timeout: 8000 });
    eq(await o.page.textContent('#warn'), '', 'the note goes away once the list arrives');
  });
});

test('offline copy: Helper\'s Update link still works when the page comes from the offline copy', async () => {
  await withOfflineCopy(async (o) => {
    await o.page.evaluate((k) => localStorage.setItem('trip-status-key', k), KEY);
    const ex = helperExport([{ date: '2026-10-19', time: '10:00', status: 'Pending' }]);
    const url = o.page.url().split('#')[0];
    await o.page.goto('about:blank');
    await o.page.goto(url + helperHash(ex)); // a new tab, like Helper opens
    await waitPut(o.gh, 1, 8000);
  });
});

// ---------------------------------------------------------------- accessibility and layout
async function a11yIssues(page) {
  return page.evaluate(() => {
    const out = { names: [], small: [], contrast: [] };
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden]'); };
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = (e) => { let base = { r: 255, g: 255, b: 255 }; const stack = []; for (let x = e; x; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } stack.reverse().forEach((c) => { base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; }); return base; };
    const ctl = Array.from(document.querySelectorAll('button, input, select, textarea, a[href], summary')).filter(vis);
    ctl.forEach((e) => {
      const name = (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || (e.labels && e.labels[0] && e.labels[0].textContent) || e.getAttribute('title') || '').trim();
      if (!name && e.type !== 'hidden') out.names.push(e.outerHTML.slice(0, 80));
      const r = e.getBoundingClientRect();
      if (r.width < 48 - 0.5 || r.height < 48 - 0.5) out.small.push((e.id ? '#' + e.id : e.className || e.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (e.getAttribute('aria-label') || e.textContent).trim().slice(0, 24) + '"');
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const e = n.parentElement; if (!n.textContent.trim() || !e || seen.has(e) || !vis(e)) continue; seen.add(e);
      const cs = getComputedStyle(e), fg = parse(cs.color), bg = bgOf(e); if (!fg) continue;
      const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
      const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const px = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700, large = px >= 24 || (bold && px >= 18.66);
      if (ratio < (large ? 3 : 4.5) - 0.01) out.contrast.push(n.textContent.trim().slice(0, 30) + ' ' + ratio.toFixed(2) + ':1 at ' + px + 'px');
    }
    return out;
  });
}
async function screens(s, fn) {
  // Every screen people see: the list, the profile picker, the new-profile form, My trips, the editor and an open trip.
  const v = await open(s, { now: NOW });
  await fn(v.page, 'list');
  await v.page.click('#meBtn'); await fn(v.page, 'profile picker');
  await v.page.click('#who [data-make]'); await fn(v.page, 'new profile');
  await v.page.locator('#who button', { hasText: 'Q.Z.' }).click(); await v.page.click('#f-all'); await fn(v.page, 'list with stars');
  await v.close();
  const e = await openEditor(s);
  await fn(e.page, 'editor');
  await e.page.click('details.more summary'); await fn(e.page, 'editor profiles');
  await editTrip(e.page, '9:45 AM'); await fn(e.page, 'open trip');
  await e.close();
  const k = await open(s, { now: NOW, hash: '#edit' });
  await fn(k.page, 'key box');
  await k.close();
}

test('a11y: every button and box has a name', async (s) => {
  const bad = [];
  await screens(s, async (p, where) => { (await a11yIssues(p)).names.forEach((x) => bad.push(where + ': ' + x)); });
  eq(bad, []);
}, { kind: 'a11y' });

test('a11y: text contrast meets WCAG AA (4.5:1, 3:1 for large text)', async (s) => {
  const bad = new Set();
  await screens(s, async (p, where) => { (await a11yIssues(p)).contrast.forEach((x) => bad.add(where + ': ' + x)); });
  eq(Array.from(bad), []);
}, { kind: 'a11y' });

test('a11y: every tap target is at least 48 by 48 px', async (s) => {
  const bad = new Set();
  await screens(s, async (p, where) => { (await a11yIssues(p)).small.forEach((x) => bad.add(where + ': ' + x)); });
  eq(Array.from(bad), []);
}, { kind: 'a11y' });

test('a11y: no sideways scrolling or cut-off text at 320 px wide with text at 200%', async (s) => {
  const bad = [];
  const check = async (p, where) => {
    await p.addStyleTag({ content: 'html { font-size: 200% !important }' });
    await sleep(50);
    const r = await p.evaluate(() => {
      const de = document.documentElement, out = [];
      if (de.scrollWidth > de.clientWidth + 1) out.push('page scrolls sideways: ' + de.scrollWidth + ' > ' + de.clientWidth);
      document.querySelectorAll('body *').forEach((e) => { const cs = getComputedStyle(e); if (!e.offsetParent || !e.textContent.trim() || e.closest('.sr-only')) return;
        if ((cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis') && e.scrollWidth > e.clientWidth + 1) out.push('cut off: ' + e.className + ' "' + e.textContent.trim().slice(0, 20) + '"'); });
      return out;
    });
    r.forEach((x) => bad.push(where + ': ' + x));
  };
  const v = await open(s, { now: NOW, size: { width: 320, height: 640 } });
  await check(v.page, 'list');
  await v.page.click('#meBtn'); await v.page.click('#who [data-make]'); await check(v.page, 'new profile');
  await v.close();
  const e = await openEditor(s, { size: { width: 320, height: 640 } });
  await editTrip(e.page, '9:45 AM'); await check(e.page, 'open trip');
  await e.close();
  eq(bad, []);
}, { kind: 'a11y' });

test('a11y: messages like Saved and No connection are announced', async (s) => {
  const o = await openEditor(s);
  const r = await o.page.evaluate(() => ['upOk', 'upBad', 'keyOk', 'keyBad', 'mMsg', 'warn', 'announce'].map((id) => { const e = document.getElementById(id); return id + ':' + (e.getAttribute('role') || e.getAttribute('aria-live') || (e.closest('[aria-live],[role=status],[role=alert]') ? 'inherit' : 'none')); }));
  eq(r, ['upOk:status', 'upBad:alert', 'keyOk:status', 'keyBad:alert', 'mMsg:alert', 'warn:status', 'announce:polite']);
  // Empty message lines must stay in the page (not display: none), or screen readers miss the words when they arrive.
  const shown = await o.page.evaluate(() => ['upOk', 'upBad', 'keyOk', 'keyBad', 'mMsg', 'warn'].filter((id) => getComputedStyle(document.getElementById(id)).display === 'none'));
  eq(shown, [], 'hidden message lines');
  await o.close();
}, { kind: 'a11y' });

test('a11y: the filters say how many trips they show', async (s) => {
  const o = await open(s, { now: NOW });
  await pickProfile(o.page, 'Q.Z.');
  await o.page.click('#f-all'); await sleep(150);
  eq(await o.page.textContent('#announce'), 'All trips: 7 trips.');
  await o.page.click('#f-mine'); await sleep(150);
  eq(await o.page.textContent('#announce'), 'My trips: none.');
  await o.close();
}, { kind: 'a11y' });

test('a11y: when one of your trips gets a driver, screen readers hear it', async (s) => {
  const d = sampleData(); d.trips.forEach((t, i) => { t.id = 't' + (1000 + i); });
  const gh = new FakeGitHub(d);
  const o = await open(s, { now: NOW, gh });
  await pickProfile(o.page, 'Q.Z.');
  await o.page.click('#f-all');
  await o.page.locator('.row', { hasText: 'Fall trip' }).locator('.take').click();
  const d2 = JSON.parse(JSON.stringify(d)), fall = d2.trips.find((t) => t.label === 'Fall trip');
  fall.drivers = ['Assigned', 'Assigned']; fall.status = 'Assigned'; d2.updated = '2026-10-19T13:10:00.000Z';
  gh.setRepo(d2); gh.publish();
  await o.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await o.page.waitForFunction(() => /now has all its drivers/.test(document.getElementById('announce').textContent), null, { timeout: 3000 });
  assert(/^Your 9:45 AM trip on Thursday, Oct 22 \(Fall trip\)/.test(await o.page.textContent('#announce')), await o.page.textContent('#announce'));
  await o.close();
}, { kind: 'a11y' });

test('a11y: one h1 and headings in order', async (s) => {
  const o = await open(s, { now: NOW });
  const hs = await o.page.$$eval('h1, h2, h3', (l) => l.filter((h) => h.offsetParent).map((h) => +h.tagName[1]));
  eq(hs.filter((x) => x === 1).length, 1, 'h1 count');
  for (let i = 1; i < hs.length; i++) assert(hs[i] <= hs[i - 1] + 1, 'heading jump ' + hs.join(','));
  await o.close();
});

test('a11y: trips are a list for screen readers', async (s) => {
  const o = await open(s, { now: NOW });
  const n = await o.page.$$eval('#days .day ul > li.row', (l) => l.length);
  eq(n, 7);
  await o.close();
}, { kind: 'a11y' });

test('a11y: status has an icon as well as color and words', async (s) => {
  const o = await open(s, { now: NOW });
  const ok = await o.page.$$eval('.chip', (l) => l.every((c) => c.querySelector('svg') && /Assigned|Pending/.test(c.textContent)));
  assert(ok, 'chips have icon + text');
  await o.close();
}, { kind: 'ui' });

test('a11y: keyboard focus is always visible', async (s) => {
  const o = await openEditor(s);
  const bad = [];
  for (let i = 0; i < 25; i++) {
    await o.page.keyboard.press('Tab');
    const r = await o.page.evaluate(() => { const a = document.activeElement; if (!a || a === document.body) return null; const cs = getComputedStyle(a); return { el: (a.id || a.className || a.tagName) + '', vis: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none' }; });
    if (r && !r.vis) bad.push(r.el);
  }
  eq(Array.from(new Set(bad)), []);
  await o.close();
}, { kind: 'a11y' });

test('a11y: Windows high contrast mode keeps chips and selected buttons visible', async (s) => {
  const o = await open(s, { now: NOW, context: { forcedColors: 'active' } });
  const r = await o.page.$$eval('.chip', (l) => l.map((c) => getComputedStyle(c).borderStyle));
  assert(r.length && r.every((x) => x !== 'none'), 'chip borders: ' + r.join(','));
  await o.close();
}, { kind: 'a11y' });

// ---------------------------------------------------------------- code
test('code: the page script only uses syntax older iPhones can run (ES2017)', async () => {
  const espree = require(process.env.ESPREE || '/opt/node-tools/node_modules/espree');
  const html = fs.readFileSync(path.join(H.ROOT, 'index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]);
  scripts.push(fs.readFileSync(path.join(H.ROOT, 'sw.js'), 'utf8'));
  scripts.forEach((src, i) => { try { espree.parse(src, { ecmaVersion: 2017, sourceType: 'script' }); } catch (e) { throw new Error('script ' + i + ': ' + e.message + ' at line ' + e.lineNumber); } });
  const banned = [/\.replaceAll\(/, /\.at\(-?\d/, /structuredClone/, /Object\.hasOwn\(/, /\.flatMap\(/, /\?\?=/, /\.findLast\(/];
  scripts.forEach((src) => banned.forEach((re) => assert(!re.test(src), 'uses ' + re)));
});

module.exports = { listed, flat };
if (require.main === module) H.run(process.argv[2]).then((n) => process.exit(n ? 1 : 0));
