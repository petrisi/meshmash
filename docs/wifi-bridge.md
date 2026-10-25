# WiFi radios through a local bridge

Status: v1 implemented, in builds made with `VITE_BRIDGE=1` only. Without it the feature is
left out of the build (no code, no UI, no CSP change). Setup guide: [bridge/README.md](../bridge/README.md).

meshmash talks to radios over Web Serial. Radios on WiFi expose a TCP port instead, and a web
page cannot open TCP sockets. `meshmash-bridge` is a small local program that relays bytes
between a WebSocket (the page) and the radio's TCP port. The page keeps all protocol code; the
bridge understands neither protocol.

```
https://www.simol.in/meshmash  ──ws://127.0.0.1:4404──▶  meshmash-bridge  ──TCP──▶  radio
        (browser)                    (loopback)            (your machine)          (WiFi)
```

## Scope

v1:
- Bridge on the same machine as the browser, listening on 127.0.0.1 only
- Meshtastic (TCP 4403) and MeshCore companion WiFi firmware (TCP 5000)
- Hosted page (www.simol.in/meshmash) as the main way in; the bridge can also serve the page itself
- One browser session per radio; automatic reconnect like USB

Not in v1:
- Remote access (bridge on another host, TLS, accounts)
- Several tabs or browsers sharing one radio
- USB radios through the bridge (would make Firefox and Safari work with USB; later)
- Meshtastic HTTP API (`/api/v1/fromradio`) directly from the page

## What the radios do (checked in firmware sources)

| | Meshtastic 2.7 | MeshCore companion 1.16 WiFi build |
|---|---|---|
| Port | TCP 4403 (`SERVER_API_DEFAULT_PORT`) | TCP 5000 (`TCP_PORT`) |
| Framing | Same as serial: `0x94 0xC3 len_hi len_lo` + protobuf | Same as serial: `<`/`>` + `len_lo len_hi` + frame |
| Clients | One. A new client force-closes the previous one (`APIServerPort::runOnce`) | One. A new client replaces the previous one (`SerialWifiInterface::checkRecvFrame`) |
| Idle | Closes a client after a period without data; meshmash already sends heartbeats | No timeout |
| Setup | WiFi SSID/PSK in the network config; WiFi disables Bluetooth on ESP32 | SSID and password compiled in (`WIFI_SSID`, `WIFI_PWD`) |
| Discovery | mDNS `_meshtastic._tcp`, TXT `id`, `shortname` | None |

**MeshCore's WiFi frame reader cannot resynchronise.** It reads 3 bytes as a header and then
waits for that many bytes. The Meshtastic wake bytes (`0xC3` × 32) that USB detection sends read
as a ~50 KB frame and stall the connection until it is reopened. Over WiFi the protocol must be
known before the first byte is sent: it comes from the bridge config, defaulting by port
(4403 → Meshtastic, 5000 → MeshCore). No probing.

## Browser constraints

Checked on Edge 155 (Chromium 155) from a public HTTPS page:

- **Mixed content:** an HTTPS page may open `ws://127.0.0.1` / `ws://localhost`. Loopback counts
  as potentially trustworthy in Chromium and Firefox. Safari has reportedly blocked it; not
  supported in v1 except through the bridge-served page.
- **Local Network Access (Chromium 147+):** a public site opening a WebSocket to loopback needs
  the per-site `loopback-network` permission. Until the user answers the prompt, the socket
  stays `CONNECTING` and nothing reaches the server. Verified: `readyState` 0 after 8 s, server
  saw no request, `navigator.permissions.query({ name: 'loopback-network' })` → `prompt`.
  After a denial Chrome does not ask again; the user must allow it in site settings.
- **CSP:** the hosted build has `connect-src 'self'`. It must become
  `connect-src 'self' ws://127.0.0.1:* ws://localhost:*`.
- **Any site can try** to open a WebSocket to loopback. Browsers do not apply CORS to
  WebSockets, so the bridge must check `Origin` itself.
- **Firefox** has no Web Serial, but it can use the bridge, so WiFi radios work there.

Bridge-served page (`http://127.0.0.1:4404/`): same origin as the WebSocket, so no
Local Network Access prompt, no mixed content, no CSP change needed, works offline. This is the
fallback when the hosted page cannot be used.

## Page ⇄ bridge protocol (v1)

One WebSocket per radio session, at `ws://127.0.0.1:4404/v1`.

Handshake:
- Subprotocols: `meshmash.v1` and `token.<base64url token>`. The bridge selects `meshmash.v1`.
  The token travels in a header, not in the URL.
- The bridge rejects with HTTP 403 before upgrading when:
  - `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding)
  - `Origin` is present and not allowed. Browsers always send it; a missing `Origin` is a
    local program, which could reach the radios directly anyway.
- Token missing or wrong: the bridge upgrades and closes at once with 4401, so the page can say
  "pair again" instead of seeing a bare network error.

Text frames are JSON control messages; binary frames are radio bytes, unchanged.

```
bridge → page  {"t":"hello","v":1,"bridge":"0.1.0","radios":[{"name":"Vuores","protocol":"meshcore","inUse":false}]}
page → bridge  {"t":"open","radio":"Vuores","takeover":false}
bridge → page  {"t":"opened","radio":"Vuores","protocol":"meshcore"}
               …binary frames both ways…
bridge → page  {"t":"closed","reason":"radio closed the connection"}   then close 4503
```

A page that only lists radios closes after `hello`.

| Close code | Meaning |
|---|---|
| 1000 | Normal close (either side) |
| 4400 | Bad control message |
| 4401 | Token missing or wrong |
| 4404 | No such radio in the bridge config |
| 4409 | Radio in use by another session (`takeover: true` replaces it) |
| 4410 | This session was taken over by another one |
| 4502 | Radio unreachable (connect failed or timed out, 5 s) |
| 4503 | Radio closed the connection |

`takeover` mirrors the firmware: the newest client wins, but only on request, so a forgotten tab
does not silently steal the radio.

## Security

- Listens on 127.0.0.1 only. No option to change that in v1.
- `Origin` allowlist. Default: `https://www.simol.in` and the bridge's own origin. More with
  `origin add` (e.g. `http://localhost:5173` for development).
- `Host` check against DNS rebinding.
- Token: off by default. The `Origin` and `Host` checks already keep other websites out, and a
  token adds a pairing step. `token on` creates 128 random bits and prints a pairing link; it
  then guards against other pages on an allowed origin and other local users' browsers.
- The bridge connects only to radios in its config. The page names a radio; it never supplies
  a host or port.
- Limits: 64 KiB per WebSocket message, one session per radio.
- Logs connection events only, never payloads. MeshCore login frames carry passwords.

### Pairing

Needed only with a token or a port other than 4404. `meshmash-bridge` then prints a link:

```
https://www.simol.in/meshmash/#bridge=127.0.0.1:4404&token=…
```

The fragment never reaches the web server. The page stores the bridge address and token in
`localStorage`, removes the fragment with `history.replaceState`, and opens the connect screen
with the bridge's radios listed. Re-pairing replaces the stored token.

## Bridge

- **Language:** TypeScript in `bridge/` with its own `package.json`, so the web app stays
  dependency-free. Node 22.18+ runs the `.ts` files directly (type stripping): no build step.
  An npm package or a single binary later.
- **WebSocket server:** the `ws` package, pinned, no dependencies of its own.
- **TCP:** `net.Socket` with `setNoDelay`, keep-alive 30 s, 5 s connect timeout. Backpressure
  via `bufferedAmount` and `socket.pause()`.
- **Config file:** `%APPDATA%\meshmash-bridge\config.json`, or
  `~/.config/meshmash-bridge/config.json`:

  ```json
  {
    "listen": 4404,
    "token": "…",
    "origins": ["https://www.simol.in"],
    "radios": [
      { "name": "Vuores", "host": "192.0.2.10", "port": 5000 },
      { "name": "zena", "host": "zena.local", "port": 4403, "protocol": "meshtastic" }
    ]
  }
  ```

- **CLI** (`node bridge/src/cli.ts …`):
  - no arguments: run
  - `add <name> <host>[:port] [--meshtastic|--meshcore]`, `remove <name>`, `list`
  - `origin add|remove <origin>`, `token on|off`
  - `--serve <dir>`: also serve a built meshmash at `http://127.0.0.1:4404/`
- **Later:** mDNS discovery of `_meshtastic._tcp`, running as a background service at login.

Files:
- `bridge/src/cli.ts`: arguments, config, start-up
- `bridge/src/config.ts`: load, validate, save, first-run token
- `bridge/src/server.ts`: HTTP server, static files, upgrade checks
- `bridge/src/session.ts`: the WebSocket ⇄ TCP pipe, control messages, takeover

## Frontend changes

1. **Transport interface** (`src/lib/transport/types.ts`): `label`, `onData`, `onClose`, `write`,
   `close`. `SerialTransport` implements it. The protocol clients and `detectProtocol` take a
   `Transport`, not `SerialTransport`.
2. **`BridgeTransport`** (`src/lib/transport/bridge.ts`): opens the socket, runs `hello` and
   `open`, and maps close codes to messages. Binary frames go to `onData`.
3. **Connect flow:** `connectBridge(bridge, radio)` in `state.svelte.ts`, next to
   `connectSerial`. It skips detection and starts the client for the protocol the bridge
   reported. The "different radio" check works as for USB.
4. **Saved radio:** `LastRadio` gets `via?: { radio: string }`. Auto-connect and
   the reconnect loop handle both kinds. A WebSocket needs no user gesture, so reconnect after a
   reload works without a click. "In use" (4409) stops the reconnect loop; a takeover (4410)
   does not start one, so two windows do not fight over a radio.
5. **Connect screen:** a "Network radios" section:
   - Not paired: how to start the bridge and open its link
   - Bridge not answering (socket fails at once): "Bridge not running at 127.0.0.1:4404"
   - Still connecting after 1.5 s with permission `prompt`: "Allow local network access in the
     browser prompt"
   - Permission `denied`: how to allow it in site settings
   - 4401: pair again
   - Otherwise the bridge's radios, each with Connect (and Take over when in use)
   - Shown in browsers without Web Serial too
6. **Status bar:** the transport label becomes e.g. `WiFi Vuores`.
7. **CSP** in `vite.config.ts`: add `ws://127.0.0.1:* ws://localhost:*` to `connect-src`.
8. **Timeouts:** USB timeouts are tuned for boards that read serial every ~20 s. Unchanged in v1;
   TCP is faster, so they are only upper bounds.

## Tests

Bridge (Node, vitest):
- Upgrade checks: a wrong `Origin` or `Host` gets 403; a missing or wrong token gets 4401
- Control flow: `hello`; `open` of an unknown radio gets 4404; a second session gets 4409;
  `takeover` closes the first session
- Pipe: bytes both ways unchanged, including frames split across TCP reads; a 64 KiB limit test
- Radio errors: connection refused or timed out gets 4502; the radio closing gets 4503
- A fake radio TCP server that replays the recorded USB captures for both protocols

Frontend:
- `BridgeTransport` against a mock WebSocket: handshake, close-code messages, data
- The connect flow with a known protocol sends no probe bytes (the MeshCore stall)
- The capture replays run through `BridgeTransport` and the fake bridge

Live:
- Meshtastic: zena on WiFi (XIAO S3; WiFi turns its Bluetooth off)
- MeshCore: a companion WiFi build
- Per radio: connect, the initial download, a DM with ACK, channel message, traceroute or trace
  path, reconnect after a radio reboot and after a page reload, takeover from a second tab
- Hosted page: the first Local Network Access prompt, denying it and recovering, pairing link
- Firefox: hosted page through the bridge

## Build switch

`VITE_BRIDGE=1 npm run build` (or `npm run dev`) defines `__BRIDGE__ = true`. The bridge code
is loaded only inside `if (__BRIDGE__)` branches (dynamic imports), so a build without it
contains none of it, and its CSP stays `connect-src 'self'`.

## Milestones

1. Bridge core: config, CLI, server, sessions, security checks, fake-radio tests
2. Frontend: transport interface, `BridgeTransport`, connect screen, saved radio and reconnect, CSP
3. Live tests on both radios; Local Network Access flows; Firefox
4. Docs (README, this file becomes the bridge guide), release 1.2.0

## Radio preparation

- **Meshtastic:** set WiFi in the network config (official app or CLI; meshmash has no config
  UI yet). Bluetooth turns off while WiFi is on. Port 4403.
- **MeshCore:** build a `*_companion_radio_wifi` environment for the board with `WIFI_SSID` and
  `WIFI_PWD` build flags, then flash it. Port 5000.
- **Both:** give the radio a fixed address (a DHCP reservation) or use its mDNS name, because
  the bridge config names the host.
