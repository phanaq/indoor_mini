# ComEd Wednesday Night Indoor signup

Signup sheet for the weekly indoor frisbee league (Wednesdays 9:30-10:30 PM). Zero dependencies, Node built-ins only, local use only.

## Run

    ADMIN_PASSWORD='choose-something' node server.js
    # open http://127.0.0.1:3000   (admin: click "Admin" at the bottom, or http://127.0.0.1:3000/#admin)

    npm test        # node:test suite

The server refuses to start if `ADMIN_PASSWORD` is unset.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `ADMIN_PASSWORD` | required | Admin login password |
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (loopback only unless you override) |
| `DATA_FILE` | `./data.json` | JSON storage file; `refunds.log` is written next to it |
| `COOKIE_SECURE` | unset | Set to `1` to add `Secure` to cookies (only useful behind HTTPS) |

## How it works

- Players log in with email + name (name and match category MMP/WMP are asked the first time an email is seen). There is no password, so anyone who knows an email can act as that player. Fine for a friendly local league, not for anything sensitive. Player sessions are in memory and reset when the server restarts.
- A registration is `{email, date, category, signedUpAt, paid, attendance}` (`attendance` is `null`, `'attended'` or `'no_show'`). Per date and category, registrations are ordered by `signedUpAt`; the first N (the threshold) are Confirmed, the rest are Waitlist #1..k. Status is computed on read and never stored.
- Unchecking deletes the registration, so the next waitlisted person moves up. Re-checking creates a fresh registration, so the player goes to the back of the waitlist (or straight to confirmed if a spot is free).
- The category on a registration is the player's profile category at signup time. Changing the profile category affects future signups only.
- Raising a threshold promotes people; lowering it demotes the latest signups. A paid registration that ends up on the waitlist is highlighted in the admin roster.

## Payment and refunds (manual, no payment API)

- Payment instructions are not shown per date; put them in the intro text (Admin > Settings).
- A spot is held on signup whether or not it is paid. The admin marks registrations paid/unpaid in the roster table and can remove unpaid people.
- If a paid registration is cancelled (by the player, by admin removal, or because the admin deletes the date), a refund record `{email, name, date, amount, status: 'owed', createdAt}` is created. The amount is what was recorded when it was marked paid.
- The admin Refunds tab lists owed refunds with a "Mark refunded" button; the nav shows a badge with the owed count. Each new owed refund is also appended as one JSON line to `refunds.log`. No email is sent.
- If the same player re-registers for that date while the refund is still owed, the refund is voided and the new registration is marked paid (credit applied).

## Activity log, game time and attendance

- `data.json` has an `events` array (missing in older files, defaults to empty, nothing is backfilled). Each event is `{id, ts, type, actor, email, name, dateId, category, details}` and is written in the same save as the change it describes. Types: `signup`, `cancel`, `promoted`, `demoted`, `paid`, `unpaid`, `refund_owed`, `refunded`, `refund_voided`, `threshold_changed`, `attended`, `no_show`, `attendance_cleared`, `admin_removed`. Promotions and demotions are found by comparing each affected date's roster before and after a change; the actor's own change is not reported as one.
- Settings `gameStartTime` (default `21:30`), `timezone` (IANA, default `America/Chicago`) and `lateCancelHours` (default `24`) are editable in the admin Settings tab. A `cancel` event records `details.hoursBeforeGame` (game start in that zone minus now, negative after the start) and `details.late` (`hoursBeforeGame < lateCancelHours`). Admin removals are logged as `admin_removed` with the hours but are not counted as cancels.
- Attendance can be set to attended or no-show only for confirmed registrations, from the roster tables; it can be cleared on any registration. A cancelled registration is still deleted, so its history lives in the events.
- Events and attendance are admin-only: they are never part of `/api/state` or any player response.

## Admin

Dates (add/remove/rename, per-date MMP/WMP thresholds and fee), intro text, Venmo handle and contact email, per-date roster tables (with signup time and an attendance control), the Refunds tab, an Activity tab (filter by date, type, name/email; late cancels are marked LATE), a Players tab (signups, cancels, late cancels, no-shows, attended per player; counts cover activity since logging began) and CSV exports of registrations (`/api/admin/export.csv`) and events (`/api/admin/events.csv`). Other admin endpoints: `GET /api/admin/events`, `GET /api/admin/players`, `POST /api/admin/attendance` with `{dateId, email, attendance}`. Admin uses a separate cookie and a rate-limited login (10 attempts per 15 minutes per IP, also applied to the player login).

## Layout

- `server.js` HTTP API and static page
- `lib/` pure logic (`logic.js`), event helper (`events.js`), game-time maths (`gametime.js`), validation, storage (atomic temp-file + rename), rate limiter, sessions
- `public/index.html` the single page
- `test/` node:test suites
- `data.json`, `refunds.log` created at runtime and gitignored
