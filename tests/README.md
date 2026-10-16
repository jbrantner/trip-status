# Tests

Everything here runs offline with made-up trips. Stand-ins take the place of GitHub and ntfy.sh, so a test can never
change the real trip list or send a real profile request.

## The page (`app.test.js`)

Needs Node and Playwright with Chromium. From the repo root:

```sh
NODE_PATH=$(npm root -g) node tests/app.test.js           # every test
NODE_PATH=$(npm root -g) node tests/app.test.js helper    # only tests with "helper" in the name
```

- `HELPER_HTML=/path/to/Helper.html` also runs the round trip through Helper's own Update Trip Status button
  (skipped without it). Helper is only read, never changed.
- `APP_DIR=/path/to/another/copy` runs the same tests against another copy of the site, for example the version
  before a change.
- `RESULTS_JSON=results.json` saves the results to a file.
- `ESPREE=/path/to/espree` points the "older iPhones" syntax check at espree if it isn't in the default place.

What they cover: the list (days, times, tags, driver spots, damaged or late data), profiles and Follow, the editing
screen (saving, merging with changes made elsewhere, retries, Undo, the key), Helper's Update link (what it may carry,
same-time trips, tags, older and newer Updates, no connection), the offline copy (`sw.js`), and accessibility (names,
contrast, 48 px targets, 320 px wide with text at 200%, announcements, focus, Windows high contrast).

## The GitHub job (`test_apply_requests.py`)

Tests `tools/apply_requests.py`, which adds coworkers' profile requests to `trips.json`:

```sh
python3 -m unittest discover -s tests -p "test_*.py"
```
