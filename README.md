# peershell

> Take your terminal anywhere and work as if it were local.

Share one live terminal session with remote peers and let them see the exact screen and type as if
local — from another **Tabby** (via the `tabby-peershell` plugin), from a **browser** (via a magic-link),
and, in future, from a dedicated **mobile app** or **our own terminal**. Same wire protocol everywhere.

It is the `tmate` / VS Code Live Share model, brokered by a lightweight rendezvous server: the host opens
a single **outbound** connection (no inbound ports, no NAT), the server pairs peers and blindly relays
frames, and it reverse-tunnels the web page from the host. See [`PROTOCOL.md`](./PROTOCOL.md).

## Security — read this first

**The MVP has NO end-to-end encryption.** The relay server sees every byte of the terminal in cleartext:
typed commands, output, environment variables, secrets, keys. **Do not use it for sensitive data unless
you self-host the relay.** Access to a shared session requires **both** a magic-link **and** a per-session
**PIN** that is validated locally and never sent to the server in cleartext. End-to-end encryption is
planned behind the same transport interface.

## Monorepo layout (npm workspaces)

```
shared/          @peershell/protocol — TS-only, framework-neutral wire protocol (published to npm)
clients/tabby/   tabby-peershell     — the Tabby plugin (Angular/Electron); all Tabby-specific code
clients/web/     @peershell/web-client — standalone browser client (xterm.js), embedded + served by host
server/          @peershell/server   — rendezvous + relay + tunnel + accounts (implemented later)
```

> This repo uses **npm workspaces** (npm >= 9). It is independent of Tabby's package manager: the plugin
> is discovered by Tabby at runtime from its built `dist/`, not installed into Tabby's workspace.

## Development

Requires Node >= 18 and a checkout of the Tabby source at `/opt/tabby` (used for `tabby-*` types; the
plugin build is self-contained and does not need Tabby's `node_modules`).

```sh
npm install            # installs all workspaces (self-contained Angular 15 + webpack toolchain)
npm run build:all      # shared -> web -> copy asset -> tabby -> server (in order)
npm run watch:tabby    # iterate on the plugin (Tabby has no hot-reload; reload its window after a build)
```

Load the built plugin into a running Tabby (on your desktop):

```sh
# option A: symlink into Tabby's user plugins dir
ln -s /opt/peershell/clients/tabby ~/.config/tabby/plugins/node_modules/tabby-peershell
# option B: dev env var (from a Tabby source checkout)
TABBY_DEV=1 TABBY_PLUGINS=/opt/peershell/clients/tabby yarn start
```

## Publishing

`tabby-peershell` is published to npm from `clients/tabby/` (keyword `tabby-plugin`, so Tabby's plugin
manager can find it). See `scripts/publish-plugins.mjs`.
