# Moving dev machines — resume note

Written 2026-11-25, right before the switch to the second laptop
(i7-8550U / 16 GB RAM / Windows 11 Pro build 26300). Everything below was
verified from GitHub's side, not just from the old working copy: both repos were
re-cloned into a scratch directory and checked out the commits named here.

## Where the work stands

Two repositories, both on GitHub under `yogneoz`:

| repo | remote (still HTTPS) | `main` HEAD | fresh clone |
| --- | --- | --- | --- |
| `ISP-Inventory-Management-System` (this one) | `https://github.com/yogneoz/ISP-Inventory-Management-System.git` | `31250fa` (plus the commit that added this note) | checks out clean |
| `ISP-Mobile-App` (sibling folder `../ISP-Mobile-App`) | `https://github.com/yogneoz/ISP-Mobile-App` | `bbc1c23` | checks out clean |

Both repositories are **still public**. Making them private is a user step with
an order: add the SSH key below first, prove `ssh -T`, and only then flip
Settings → General → Danger zone → *Change visibility*. Flipping first strands a
machine that has neither the key nor a browser login.

Latest ERP commits:

- `c704548` — proof-attach path driven end to end with an armed image picker
- `392dc9b` — job detail and completion against the seeded visit
- `c6153b0` — the five More-hub mobile screens mounted against seeded projections
- `a5df41a` — an expense claim for every demo login, asserted in the surface gate

Test suite: **2898 tests · 2875 pass · 0 fail · 23 skipped**; `npm test` also runs
the docs-count gate (`2898` pinned in `README.md`, `handoff.md`,
`SESSION_NOTES.md`). Demo seed: AR 10,000 / AP 15,000 / Inventory 20,000 /
Cash+Bank 10,000 / Equity 50,000, per-branch trial balance 0/0/0/0.

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
   `NODE_ENV=development`. `.env.example` documents every variable and the guard
   test `tests/envDocs.guard.test.ts` keeps it in step with the code; the values
   in it (`securepassword`, a placeholder token secret) are local-demo defaults,
   not credentials for anything remote.
4. Seed: `POSTGRES_HOST=<wsl ip> POSTGRES_DB=inventory_db npx tsx scripts/seed_verification_data.ts`
   — it clears and rebuilds every demo table and prints the balance report.
5. Run the gates:
   - `npm test` (≈25 min; run it with no dev server on 127.0.0.1:3000 — the
     outbox flusher races the CLI tests). Do not start it minutes before UTC
     midnight: three suites key fixture dates off `new Date()` and fail when the
     clock rolls over mid-run.
   - `npx tsc --noEmit`, `(cd mobile-expo && npx tsc --noEmit)`, `npm run build`
   - `npm run check:no-inline-sql`, `check:audit-await`, `check:branch-predicates`,
     `check:no-raw-dialogs`, `check:contract-parity`
   - `check:partitions` and `check:demo-coverage` (these two need `POSTGRES_HOST`)
6. Dev server: `npx tsx server/index.ts`, then open `http://127.0.0.1:3000`.
   Demo logins are `superadmin@example.com` … `auditor@example.com`, password
   `Demo@123`.

## SSH key — user steps that remain

An ed25519 pair was generated on the old machine:

- private: `~/.ssh/isp_github_ed25519` (mode `600`)
- public: `~/.ssh/isp_github_ed25519.pub`

The public key line to paste at **GitHub → Settings → SSH and GPG keys → New SSH
key** (title: `isp-erp old machine`):

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP7Oli9JbWg4KZUnCwMipKNWPZ7OjB2gQZGncYErPXTA isp-erp@ClientAccount
```

It is **not** registered yet, and that could not be done from this box:

- no `gh` CLI is installed (`gh: not installed`);
- no `GH_TOKEN` / `GITHUB_TOKEN` in the environment;
- Git Credential Manager does hold an OAuth token for `yogneoz` (scopes
  `gist, repo, workflow`), which pushed these commits, but it lacks
  `admin:public_key`: `GET /user/keys` and `POST /user/keys` both answer
  `404 Not Found`, which is GitHub's answer for a token without that scope.

So the remotes stay on HTTPS (pushing works today) and SSH is switched only after
the key is on the account:

```
# on the old machine, once ssh -T git@github.com answers "Hi yogneoz!"
git remote set-url origin git@github.com:yogneoz/ISP-Inventory-Management-System.git
git -C ../ISP-Mobile-App remote set-url origin git@github.com:yogneoz/ISP-Mobile-App.git
ssh -T git@github.com
git push --dry-run origin main
git -C ../ISP-Mobile-App push --dry-run origin main
```

Carrying the key to the new machine: copy **both** files — `~/.ssh/isp_github_ed25519`
and `~/.ssh/isp_github_ed25519.pub` — into `~/.ssh/` on the new machine (a USB
stick, a password manager attachment, or `scp` over the LAN), then:

```
chmod 700 ~/.ssh && chmod 600 ~/.ssh/isp_github_ed25519
ssh-keygen -y -f ~/.ssh/isp_github_ed25519   # prints the public key; must match the line above
```

The private key must never enter either repository: it lives in `~/.ssh`, both
working copies ignore it, and a scan of all 556 ERP commits and both mobile
commits found no key material (see below).

## Secret scan of what is actually on GitHub

Run against fresh clones (`git ls-tree -r HEAD`, `git log --all --name-only`, and
`git grep` over every commit) on 2026-11-25:

| check | ERP | mobile |
| --- | --- | --- |
| `BEGIN … PRIVATE KEY` in any commit | none | none |
| `ssh-ed25519 AAAA…` in any commit | only the truncated **public** key in this note | none |
| `ghp_…` / `github_pat_…` / `AKIA…` tokens | none | none |
| `id_rsa` / `id_ed25519` / `.pem` / `.p12` / `.jks` / keystore files | none | none |
| tracked `.env` | none (`.env.example` only; `.gitignore:9` covers `.env*`) | none (`.env.example` only) |
| working-copy `.env` tracked | no | no |

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
