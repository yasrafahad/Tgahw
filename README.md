# تَقْهوَّ · Tgahw — QR Desk Ordering

Scan the QR sticker on your desk → pick a drink → it appears on the pantry screen with your desk number.

## Quick start

Needs **Node.js** installed (any recent version — the database auto-selects the best available driver).

```bash
npm install
node server.js
```

- **Pantry screen**: http://localhost:3000/staff
- **Admin page**: http://localhost:3000/admin  (PIN: `1234` — change it, see below)
- **Order page**: opened by scanning a desk QR. For testing you can use a token from `desks.json`, e.g. `http://localhost:3000/order?t=THE_TOKEN`

## Change the admin PIN (do this before going live)

```bash
# Windows (PowerShell)
$env:ADMIN_PIN="7788"; node server.js
# Mac/Linux
ADMIN_PIN=7788 node server.js
```

## Security: tokenised QR codes

Each desk has a private, unguessable token. The QR encodes `?t=<token>`, **not** the desk name — so nobody can guess another desk's URL and spam orders. An unknown or edited token is rejected with a clear "invalid QR" screen.

## Features

**Order page** (per desk)
- Desk resolved from the QR token, bilingual menu with drawn icons
- Options (sugar / mint), quantity, note, live wait estimate
- Live status → delivered, 👍 feedback, "order my usual"
- **Report a problem** (escalation) attached to a recent order
- English / عربي toggle with full RTL, bundled Plex Sans Arabic font (works offline)

**Meeting rooms** — get an extra **Call the pantry** button: Order drinks / Refill / Clear the table / Something else. Regular desks don't show this.

**Pantry screen** (`/staff`)
- Live order cards, floor filter, pause/resume
- **Out-of-stock toggle** (📦 Stock): mark any drink out — it instantly disappears from ordering for all desks and rooms
- **Room call alerts** with sound + a pulsing banner
- **Sound + visual alert** on every new order (toggle with the 🔔 button)
- **Undo** on a delivered order (8-second toast) for misclicks
- Daily counters

**Admin page** (`/admin`, PIN)
- **Dashboard**: Today / Week / Month / Year — KPIs and charts (top drinks, by floor, top desks, by hour)
- **Escalations** queue with resolve
- **Menu & categories**: add / rename / delete / reorder categories (EN + AR), edit drinks & icons, availability
- **Desks**: add / disable seats & rooms, filter by floor, **show/print each desk's QR**
- **Service**: pause + message, working hours
- **Backup**: one-click download of the whole database

## Database

SQLite, created automatically as `data.sqlite`. The app **auto-detects** the best driver:
- **Node 22.5+**: uses the built-in `node:sqlite` — writes each order to disk immediately (safest).
- **Older Node**: falls back to `sql.js` (bundled), which writes to disk moments after each change.

Either way your data survives restarts. This is the right database for a single-office tool at this scale.

**Backups:** use the admin "Download backup" button periodically, or just copy `data.sqlite` while the server is stopped. To wipe all orders before going live: stop the server, delete `data.sqlite`, restart — menu and desks are untouched.

## QR stickers

1. Find your server's LAN address (e.g. `192.168.1.50`) — phones must reach it over Wi-Fi.
2. Generate:

```bash
# Windows (PowerShell)
$env:BASE_URL="http://192.168.1.50:3000"; node generate-qr.js
# Mac/Linux
BASE_URL=http://192.168.1.50:3000 node generate-qr.js
```

Creates one PNG per seat in `qr-codes/` plus `qr-codes/print-sheet.html` (grouped one floor per page, rooms marked). Or generate/print a single desk's QR from the admin Desks list.

**Before printing all 227:** run the server, print one sticker, scan it on the office Wi-Fi to confirm.

## Going live — checklist

1. Put the folder on an always-on machine with a **static IP** (or DNS name).
2. `npm install`, set a real `ADMIN_PIN`, `node server.js`.
3. Open port 3000 on the firewall so phones can reach it.
4. In `/admin`: set working hours, check the menu, mark anything unavailable.
5. Generate QRs with the real `BASE_URL`, scan-test one, print per floor.
6. Put `/staff` on a pantry tablet, full screen. Tap once so sound alerts are allowed by the browser.
7. Schedule a routine backup (admin download, or copy `data.sqlite`).

## Files

| File | Purpose |
|---|---|
| `server.js` | Backend + API |
| `db.js` | SQLite layer (auto-selects driver) |
| `menu.json` | Menu + categories |
| `desks.json` | 227 seats with private tokens |
| `public/order.html` | Phone order page |
| `public/staff.html` | Pantry screen |
| `public/admin.html` | Admin (dashboard, escalations, menu, desks, service, backup) |
| `public/fonts/` | Bundled Plex Sans Arabic (SIL OFL) |
| `generate-qr.js` | QR + printable sheet generator |
| `data.sqlite` | Orders, escalations, room calls (auto-created) |

## Not built (future)
- Username + password login with roles (currently a shared PIN)
