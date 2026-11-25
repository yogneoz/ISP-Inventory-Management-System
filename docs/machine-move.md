# Moving dev machines — resume note

Written 2026-11-25, right before the switch to the second laptop
(i7-8550U / 16 GB RAM / Windows 11 Pro build 26300). Everything below is true of
`main` at the commit that added this file.

## Where the work stands

Two repositories, both on GitHub under `yogneoz`:

| repo | remote | state |
| --- | --- | --- |
| `ISP-Inventory-Management-System` (this one) | `https://github.com/yogneoz/ISP-Inventory-Management-System.git` | pushed, working tree clean |
| `ISP-Mobile-App` (sibling folder `../ISP-Mobile-App`) | `https://github.com/yogneoz/ISP-Mobile-App` | pushed, working tree clean |

Both are being switched to **private**; access is then by the SSH key described
below (or a GitHub login through Git Credential Manager).

Latest ERP commits:

- `c704548` — proof-attach path driven end to end with an armed image picker
- `392dc9b` — job detail and completion against the seeded visit
- `c6153b0` — the five More-hub mobile screens mounted against seeded projections
- `a5df41a` — an expense claim for every demo login, asserted in the surface gate

Test suite at this commit: **2898 tests · 2875 pass · 0 fail · 23 skipped**;
`npm test` also runs the docs-count gate (`2898` pinned in `README.md`,
`handoff.md`, `SESSION_NOTES.md`). Demo seed: AR 10,000 / AP 15,000 / Inventory
20,000 / Cash+Bank 10,000 / Equity 50,000, per-branch trial balance 0/0/0/0.

## First steps on the new machine

1. `git clone git@github.com:yogneoz/ISP-Inventory-Management-System.git` and the
   mobile repo beside it (`ISP-Mobile-App`), then `npm install` in each. Keep the
   folder layout (`ISP-Inventory-Management-System/` next to `ISP-Mobile-App/`),
   because the mobile repo is referenced by sibling path.
2. PostgreSQL lives in **WSL Ubuntu 24.04** (`postgres` / `postgres`,
   database `inventory_db`, app role `inventory_user` / `securepassword`).
   Windows resolves `localhost` to IPv6, so scripts must target the distro
   address: `ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+'` inside WSL. WSL
   keeps that address across reboots on this setup, but re-check it.
3. Put the connection details in `.env` (never commit it): `DATABASE_URL`,
   `POSTGRES_HOST=<wsl ip>`, `POSTGRES_DB=inventory_db`, `AUTH_TOKEN_SECRET`,
   `NODE_ENV=development`.
4. Seed: `POSTGRES_HOST=<wsl ip> POSTGRES_DB=inventory_db npx tsx scripts/seed_verification_data.ts`
   — it clears and rebuilds every demo table and prints the balance report.
5. Run the gates:
   - `npm test` (≈25 min; run it with no dev server on 127.0.0.1:3000 — the
     outbox flusher races the CLI tests)
   - `npx tsc --noEmit`, `(cd mobile-expo && npx tsc --noEmit)`, `npm run build`
   - `npm run check:no-inline-sql`, `check:audit-await`, `check:branch-predicates`,
     `check:no-raw-dialogs`, `check:contract-parity`
   - `check:partitions` and `check:demo-coverage` (these two need `POSTGRES_HOST`)
6. Dev server: `npx tsx server/index.ts`, then open `http://127.0.0.1:3000`.
   Demo logins are `superadmin@example.com` … `auditor@example.com`, password
   `Demo@123`.

## SSH key

An ed25519 pair was generated on the old machine:

- private: `~/.ssh/isp_github_ed25519`
- public: `~/.ssh/isp_github_ed25519.pub`
  (`ssh-ed25519 AAAA…PXTA isp-erp@ClientAccount`)

To use it on the new machine: copy **both** files into `~/.ssh/` there
(`chmod 600` the private one), add the **public** key at
GitHub → Settings → SSH and GPG keys, then
`ssh -T git@github.com` should answer `Hi yogneoz!`. The remotes are still HTTPS;
switch them once the key is registered:

```
git remote set-url origin git@github.com:yogneoz/ISP-Inventory-Management-System.git
git -C ../ISP-Mobile-App remote set-url origin git@github.com:yogneoz/ISP-Mobile-App.git
```

The private key is deliberately **not** in either repository.

## What is still open

- On-device behaviour is unverified: the Kotlin app cannot be built here (no JDK
  or Android SDK), and every mobile assertion runs in jsdom against the RN/Expo
  stubs. The image-picker sheet itself, camera permissions on a real device, and
  Expo Go rendering remain device-only checks.
- Web-portal screens (HR Reports and the rest of the admin UI) are covered by API
  tests, not by a rendered check.
- The Approvals mobile screen's punch queue is empty by fixture (every seeded
  proof is `ACCEPTED` and outside the 14-day window); the empty state is asserted
  rather than hidden.
