# ISP Workplace (Expo Go client)

A second mobile client for the portal. It consumes only the routes already
documented in [`docs/contracts/mobile-v1.md`](../docs/contracts/mobile-v1.md)
and pinned by `npm run check:contract-parity` — it adds no endpoint and never
talks to PostgreSQL. The Kotlin client remains supported by the same contract.

## What it does today

- Sign in with a portal account (`POST /api/v1/auth/login`).
- **Jobs** — the technician's open/assigned visits (`GET /api/v1/workplace/jobs`).
- **Proof of work** — open a job, list its captures
  (`GET /api/v1/workplace/jobs/:id/evidence`), attach a photo from the library
  (`POST .../evidence`). Stored, replayed and over-ceiling outcomes are shown as
  sentences, and the 2 MiB ceiling is checked before the upload is sent.
- **My stock** — the van's custody holdings (`GET /api/v1/workplace/stock`).
- **Payslips** — behind the contract's re-authentication
  (`POST /api/v1/auth/re-auth` then `GET /api/v1/payslips` with `x-reauth-token`).
- **Profile** — `GET /api/v1/profile`.

Not in this build: punch in/out, job completion, approvals, offline sync push —
all of which already have routes and are the natural next slice.

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
