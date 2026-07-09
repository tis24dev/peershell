# peershell wire protocol (v1 draft, frozen at Stage 5)

Language-neutral spec of the peershell wire protocol. Implemented once in `@peershell/protocol`
(`shared/`) and consumed by every client (Tabby plugin, web-client, future native terminal, future
mobile app) and by the server. Native ports (Swift/Kotlin/Dart) should follow this document.

## Roles and transport

- **host**: a Tabby (or future terminal) instance sharing one local terminal session. Opens a single
  **outbound** WSS connection to the server. No inbound ports, no NAT traversal, no STUN/TURN.
- **guest**: a peer that views + controls the shared session (Tabby desktop, browser via magic-link,
  or mobile). Connects to the server (browser/mobile reach the server's public URL via cloudflared).
- **server**: rendezvous + blind relay + reverse HTTP tunnel + accounts/dashboard. After pairing it
  **forwards every frame verbatim** between host and a guest; it never needs to parse terminal bytes.

Data path is always host <-> server <-> guest. There is no direct peer link in the MVP; the transport
sits behind a `SessionTransport` interface so a future WebRTC DataChannel can replace the relay leg.

## Framing

One WebSocket carries two frame kinds (`ws.binaryType = 'arraybuffer'`):

- **TEXT frame = JSON control message**: the envelope below.
- **BINARY frame = terminal data**: layout:

  ```
  [ peerId: uint32 big-endian ][ tag: uint8 ][ raw PTY bytes ... ]
  tag: 0x01 = output (host -> guest),  0x02 = input (guest -> host)
  ```

  Raw PTY bytes are **never** decoded as UTF-8 in transit. A multibyte codepoint may be split across
  frames; the **receiving client** is responsible for reassembling via a UTF-8 splitter before writing
  to its terminal (Tabby desktop gets this from `UTF8SplitterMiddleware`; web/mobile use
  `@peershell/protocol`'s `Utf8Splitter`). MVP uses `peerId = 0` (1 host + 1 guest). `peerId` exists so
  the server can route frames once multiple guests are supported.

## Control envelope

```
{ "t": <type>, "v": 1, "peerId"?: <uint32>, ... }
```

`v` is `PROTOCOL_VERSION` (currently 1). Unknown/incompatible `v` -> `error{code:"bad-version"}`.

### REST (client -> server, not WebSocket)
- `POST /register { email, password }`
- `POST /login { email, password } -> { token, expiresAt } | { needsTotp: true, sessionKey }`
- `POST /2fa/verify { sessionKey, code } -> { token, expiresAt }`
- `GET /sessions -> { account: { email, totpEnabled, totpEnabledAt }, sessions: [{ room, magicLink, createdAt, endedAt, live, hasGuest }] }`  (dashboard, authenticated)

### Signaling (client <-> server, WS TEXT)
- `hello { role: "host"|"guest", kind?: "desktop"|"web"|"mobile", client }`
- `create-session { }` (host, authenticated) -> `session-created { room, magicLink }`
- `session-close { }` (host): revokes the magic-link
- `join { room?|token?, name? }` (guest)
- `peer-joined { peerId, kind }` (to host)
- `peer-left { peerId, reason }`
- `error { code, message }`
- `ping {}` / `pong {}`

### PIN auth (host <-> peer, relayed; gates every incoming connection)
- `pin-challenge { nonce }`: host sends a **fresh, single-use** nonce per attempt
- `pin-response { hash }`: `hash = H(pin, nonce)` (e.g. SHA-256); raw PIN never sent
- `pin-ok {}` / `pin-fail { left }`: host verifies locally; rate-limited (~5 tries), then kick

### Sync (after pin-ok, relayed)
- `snapshot { cols, rows, data }`: `data` = base64 of the host's `frontend.saveState()` VT snapshot
- `snapshot-ack {}`: guest confirms it rendered the snapshot; **barrier**: host starts streaming
  `output` only after receiving the ack (avoids output-before-snapshot race)
- `resize { cols, rows }`: host -> guest only (tmate model; guest never resizes the host PTY)

### Terminal data (after pin-ok + snapshot-ack)
- BINARY tag `0x01` output (host -> guest), `0x02` input (guest -> host). See Framing.

### HTTP tunnel (server <-> host, serves the web-client page over the host's outbound leg)
- `http-get { peerId, reqId, path, headers }`
- `http-response { peerId, reqId, status, headers, bodyBase64 }`
- Correlation key = `(peerId, reqId)`. NOT real HTTP: these are application frames over the WS; the
  Electron renderer does not open a listening port. The host validates `path` against a strict
  **whitelist** (only `/`), rejecting traversal/SSRF (`..`, absolute paths, `file://`, `http://`);
  anything else -> `403`.

## Tokens, PIN, keepalive

- **magic-link token**: opaque, CSPRNG, **TTL 15 min** (default, configurable), **single-use = revoked
  after a join completes (post `pin-ok`)**, not on first GET. Expired join -> `error{code:"link-expired",
  suggestRenew:true}`. Host can revoke anytime.
- **room-code** (if shown): Crockford base32 minus ambiguous chars; client validates `^[2-9A-HJ-NP-Z]{6,10}$`.
- **PIN**: per-session, local only, min 6 digits (8+ recommended for hostile environments). Verified via
  `H(pin, nonce)` challenge-response. A hostile relay sees `nonce`+`hash` and can brute-force short PINs
  **offline**, hence entropy + rate-limit; a future PAKE (SPAKE2) removes this if the relay is untrusted.
- **keepalive**: `ping` every 20s from both ends; `ping`/`pong` do **not** reset the liveness timer, only
  real frames (control/snapshot/output/input) do. No real frame for 60s -> close + `peer-left`.

## Security note (MVP)

The MVP has **no end-to-end encryption**: the relay sees terminal I/O in cleartext (commands, output,
env vars, secrets). Self-hosting is required for production use. An E2E layer (e.g. ChaCha20/AES-GCM with
a key derived from the PIN/passphrase) can be added behind `SessionTransport` without changing this
protocol's shape. The PIN itself never crosses the wire in cleartext.
