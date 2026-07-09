# peershell — User Guide

> Take your terminal anywhere and work as if it were local.

peershell lets you **share one live terminal session** with remote people and let them **see the exact
screen and type as if they were local** — the `tmate` / VS Code Live Share model. You share from a
desktop terminal (the **Tabby** plugin) and the other person joins from **another Tabby** or straight
from a **web browser** via a one-time link. A dedicated mobile app is planned.

This guide is for **users**. It covers accounts, sharing, joining (desktop / browser / mobile), the web
dashboard, and security. Keep it as the living reference — we add to it as features land.

---

## 1. Read this first — security

peershell is designed to be simple and to work through firewalls with **no inbound ports**. Understand
what it does before sharing:

- **A guest gets a full read‑write shell.** Whoever joins can see everything on that terminal and can
  type commands. Only share with people you trust, and only the terminal you mean to.
- **No end‑to‑end encryption yet.** Traffic is encrypted in transit (HTTPS/WSS), but the **relay server
  sees the terminal contents in clear text** (commands, output, environment variables, secrets). Do not
  share sensitive sessions on a server you do not control. For sensitive use, **self‑host the server**.
- **Two things are always required to join:** the **magic link** *and* a **per‑session PIN**. The PIN
  lives only on the host, is never sent to the server, and gates every incoming connection. The link
  alone is not enough.
- **Passwords are never stored in plain text.** Accounts store a salted, one‑way **scrypt** hash only;
  nobody (not even the operator) can recover your password — only reset it.

The first time you share, peershell shows a one‑time confirmation of the above. You can proceed or cancel.

---

## 2. Concepts at a glance

| Term | Meaning |
|------|---------|
| **Host** | The person sharing their terminal (runs the Tabby plugin). |
| **Guest** | The person who joins — from another Tabby or a browser. |
| **Account** | Email + password (optional 2FA). Required to *share*; guests do not need one. |
| **Magic link** | A one‑time URL the host sends to a guest. Opens the shared terminal in a browser. |
| **PIN** | A per‑session code the host sets. The guest must enter it to connect. |
| **Server** | The rendezvous/relay. Hosted at `panel.peershell.dev`, or self‑hosted. |
| **Dashboard** | The web page at the server root to log in and see your sessions. |

---

## 3. Accounts

You need an account to **share** a terminal. Guests joining a link do **not** need an account.

### Register / log in
You can manage your account in two places — they are the **same accounts**:
- In Tabby: the **peershell** toolbar button → **Log in**.
- In a browser: open the server (e.g. `https://panel.peershell.dev/`) → the login page.

Enter your **email** and a **password** (at least 8 characters), then:
- **Log in** — sign in to an existing account.
- **Register** — create a new account (registers and signs you in directly).
- **Recover password** — start a password reset.

### Email verification
When email delivery is enabled on your server, registering sends a **6‑digit code** to your email; enter
it to finish. If email delivery is not yet enabled, registration signs you in immediately (the code is
written to the server log instead). Either way you end up signed in.

### Two‑factor authentication (2FA), optional
You can protect your account with an authenticator app (TOTP, e.g. Google Authenticator). When enabled,
logging in asks for the current 6‑digit code after your password. You enable/disable 2FA from the account
options (disabling requires your password).

### Password reset
Choose **Recover password**, enter your email, then the reset **code** (from your email, or the server
log if email is not enabled) and a **new password**.

### Log out
- Tabby: peershell menu → **Log out**.
- Browser dashboard: **logout** in the top bar.

---

## 4. Installing the Tabby plugin

The plugin adds peershell to **Tabby** (desktop terminal). Publishing to npm is planned; for now it is
installed manually.

**Where Tabby keeps plugins:** its user data folder, under `plugins/node_modules/`. On Windows this is
`%APPDATA%\tabby\plugins\node_modules\`. (In Tabby: **Settings → Plugins** links to the folder.)

**Install:**
1. Put the `tabby-peershell` folder (containing `package.json` and `dist/index.js`) into
   `…\plugins\node_modules\tabby-peershell\`.
2. **Fully quit Tabby**, including from the system tray (right‑click the tray icon → Quit), then reopen.
   Tabby only loads plugins at startup, so a full restart is required after installing or updating.

**Verify it loaded:** you should see a **peershell** button in the toolbar and a **peershell** tab under
Settings. The server is preconfigured to `wss://panel.peershell.dev`; you can change it in
**Settings → peershell** if you self‑host.

---

## 5. Sharing a terminal (host)

1. Make sure you are **logged in** (peershell menu → Log in).
2. **Focus the terminal** you want to share (click into it).
3. Open the **peershell** toolbar menu → **Share this terminal**. (You can also right‑click inside a
   terminal → *Share this terminal (peershell)*.)
4. Accept the one‑time **security notice**.
5. peershell shows a window with the **magic link** and the **PIN**, each with a **Copy** button. Send
   **both** to your guest (over a trusted channel). Click **Done** — sharing keeps running in the
   background while that terminal tab stays open.

While sharing, the peershell menu entry for that terminal changes to **Stop sharing this terminal**.

---

## 6. Joining a shared terminal (guest)

### From a web browser (any device)
1. Open the **magic link**.
2. Enter the **PIN** when prompted.
3. The shared terminal appears. You can read it and type — it is full read‑write and adopts the host's
   window size.

### From another Tabby (desktop)
1. peershell menu → **Join a shared terminal**.
2. Enter the **room code** and the **PIN**.
3. A mirror tab opens with the shared terminal.

### On a phone or tablet (browser)
Mobile keyboards lack arrow keys and modifiers, so the browser view shows an **on‑screen keys bar** at
the bottom:
- **Esc · Tab · Ctrl · Alt · ← ↓ ↑ → · ^C · Home · End · PgUp · PgDn · | / - ~** (scroll it sideways for
  more).
- **Ctrl** and **Alt** are *sticky*: tap Ctrl (it highlights), then tap a letter to send e.g. Ctrl‑C.
- Arrows work correctly inside full‑screen apps like `vim`/`less`.
- The **⌨** button (top‑right) hides/shows the bar. On desktop the bar is hidden by default.

---

## 7. Ending a session

**Host** — any of:
- peershell menu → **Stop sharing this terminal**.
- Right‑click in the terminal → *Stop sharing (peershell)*.
- Close the terminal tab.

**Guest** — close the browser tab (or the mirror tab in Tabby).

**Automatic close on guest disconnect:** if the guest disconnects, the host waits about **10 seconds**
for them to come back before ending the session. A brief network blip is survived automatically — the
browser view reconnects on its own (re‑using the PIN) — but if the guest is really gone, the share ends.

**Auto‑stop if never used:** if **no guest connects within about 5 minutes** of starting a share, the
host stops it automatically.

**Link lifetime:** a magic link expires after ~15 minutes.

---

## 8. The web dashboard

Open the server in a browser (e.g. `https://panel.peershell.dev/`) and log in. You get:
- A top bar showing your **email** and a **logout** button.
- A table of **your sessions**, both live and ended:
  - **Status** — *live* or *ended*.
  - **Opened** / **Closed** — the times.
  - **Link** — an **open** link for sessions that are still live.

Use *Refresh* to update the list.

---

## 9. Troubleshooting

- **The plugin/menu didn't update after an install.** Quit Tabby completely (including the tray icon),
  then reopen — plugins load only at startup.
- **"Cannot reach the peershell server."** Check **Settings → peershell → Server URL** (default
  `wss://panel.peershell.dev`).
- **"Log in to share a terminal."** You must be signed in before sharing.
- **"Focus a terminal tab to share it."** Click into a terminal first, then use Share.
- **Share menu says Share, not Stop.** Make sure you are on the tab whose terminal is being shared.
- **Didn't get the email code.** If email delivery isn't enabled yet on your server, the code is written
  to the server log; ask the operator, or you may already be signed in.

---

## 10. Status & what's next

**Working today:** accounts (register / login / optional 2FA / password reset), sharing from Tabby,
joining from another Tabby or a browser, the mobile keys bar, automatic reconnect/grace on guest drops,
the web dashboard, and scrypt‑hashed passwords. The server runs at `panel.peershell.dev` and is
self‑hostable.

**Planned:** publishing the plugin to npm, a dedicated **mobile app**, and optional **end‑to‑end
encryption**. Email delivery (verification / reset codes) is being finalised with an external provider;
until then those codes appear in the server log.

---

*This document is the living user reference for peershell. We extend it as features ship.*
