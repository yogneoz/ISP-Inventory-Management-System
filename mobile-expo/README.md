# ISP Workplace (Expo Go client)

A second mobile client for the portal. It consumes only the routes already
documented in [`docs/contracts/mobile-v1.md`](../docs/contracts/mobile-v1.md)
and pinned by `npm run check:contract-parity` — it adds no endpoint and never
talks to PostgreSQL. The Kotlin client remains supported by the same contract.

## What it does today

Five tabs — **Today**, **Jobs**, **Attendance**, **Leave**, **More** — covering
both the read and the write side of every workplace route the contract lists.

- Sign in with a portal account (`POST /api/v1/auth/login`); the device is bound
  on the same call (`POST /api/v1/devices/register`).
- **Today** — `GET /api/v1/workplace/bootstrap`: punch state, shift window,
  branch fence, unread notices, pending approvals, van location and the
  announcements. **Clock in / Clock out** sends a real geofenced punch
  (`POST /api/v1/workplace/attendance/punch`) with the phone's coordinates and
  shows the server's verdict, held reason and times.
- **Jobs** — the technician's open/assigned visits (`GET /api/v1/workplace/jobs`).
  Open a job for its captures (`GET .../evidence`), attach a photo from the
  library (`POST .../evidence`, 2 MiB checked before the upload) and **complete
  the visit** (`POST .../complete`) with the phone's own `baseVersion`, so a job
  changed elsewhere is refused instead of overwritten.
- **Attendance** — `GET /api/v1/attendance`: the 90-day window, its summary
  (present / leave / absent / overtime) and every record with its shift.
- **Leave** — `GET /api/v1/leaves` balances and requests, **request leave**
  (`POST /api/v1/leaves/requests`) and **withdraw** a pending one
  (`POST /api/v1/leaves/requests/:id/cancel`).
- **More** — my stock (`GET /api/v1/workplace/stock`), payslips
  (`POST /api/v1/auth/re-auth` then `GET /api/v1/payslips` with
  `x-reauth-token`), approvals (`GET /api/v1/workplace/approvals` plus
  `POST /api/v1/workplace/approvals/:kind/:id`), expense claims
  (`POST /api/v1/workplace/claims`, `GET .../claims/:id`), documents
  (`GET /api/v1/documents`), the audited PAN/SSF/bank read
  (`GET /api/v1/hr/me/sensitive`) and the profile with its contact form
  (`PUT /api/v1/employees/me/contact`).

Every sensitive screen asks for the password again; the everyday profile card
carries no PAN, SSF, bank or salary field.

Not in this build: the offline sync queue (`/sync/pull`, `/sync/push`), the
location breadcrumb batch and FCM token registration. The routes exist; the app
currently reads live and writes one action at a time.

## Run it here

```bash
cd mobile-expo
npm install                 # first time only
cp .env.example .env        # then set EXPO_PUBLIC_API_BASE to this PC's LAN IP
npx expo start --lan
```

Then scan the QR code with **Expo Go** on the phone (Android: inside the app;
iOS: the Camera app). The phone and this PC must be on the same network.

The app talks to the portal directly, so the portal must be reachable from the
phone at `http://<PC-LAN-IP>:3000` — the dev server binds `0.0.0.0`, but the
Windows firewall has to allow the port. If the phone cannot load the bundle,
`npx expo start --tunnel` routes the dev server over the internet; the API base
still has to be reachable by the phone, so a LAN address is required either way.
