# Meshtastic advanced features — client reference

Implementation reference for a client that talks to a Meshtastic node over the stream API
(`0x94 0xC3 len16` + `ToRadio`/`FromRadio`). Covers request/response features beyond plain text
messaging: what to send, what comes back, field numbers, and what the firmware refuses or
rate-limits. Settings are in [config.md](config.md).

## Sources and version labels

Primary source is firmware source. Where firmware and meshtastic.org disagree, firmware wins.

| Label | Firmware tag | Protobufs commit (firmware submodule pin) |
|---|---|---|
| 2.7.15 | `v2.7.15.567b8ea` | `7654db2` |
| 2.7.26 | `v2.7.26.54e0d8d` | `6b1ded4` |
| 2.8.0 | `v2.8.0.7239fe8` | `7b2464c` (= protobufs tag `v2.8.0`) |
| master | protobufs `master` (2026-10) | — |

File references are relative to the firmware repo (`src/...`). "2.7.x" means "2.7.15 and 2.7.26
behave the same". Version boundaries marked "since 2.7.N" were found by checking intermediate tags
(`v2.7.16`–`v2.7.25`) for the code in question.

Notation: `Msg.field (N)` = field number N. `PortNum` names are from `portnums.proto`.

---

## 0. Common mechanics

### 0.1 Sending a MeshPacket from the client

`ToRadio.packet (1)` = `MeshPacket`. Fields a client sets:

| MeshPacket field | # | Client sets | Firmware behaviour (`MeshService::handleToRadio`, `Router::sendLocal`, `Router::send`) |
|---|---|---|---|
| `from` | 1 | ignore | Forced to 0, later replaced by own node num. |
| `to` | 2 | dest node num, or `0xFFFFFFFF` broadcast | `to == own node num` → handled locally (local admin, local telemetry request). `to == 1` (`NODENUM_BROADCAST_NO_LORA`) = broadcast over non-LoRa transports only. |
| `channel` | 3 | channel **index** 0–7 | For a unicast with `channel == 0` and `pki_encrypted == false`, firmware replaces it with the channel it last heard the destination on (`NodeInfoLite.channel`). |
| `decoded` | 4 | `Data` | see below |
| `id` | 6 | random non-zero uint32 | 0 → firmware generates one. Firmware drops a ToRadio packet whose `id` is among the last 20 ids it saw from this client (`PhoneAPI::wasSeenRecently`). |
| `hop_limit` | 9 | 0–7 | Copied to `hop_start`. 0 = direct neighbours only, **except** `want_ack && hop_limit == 0` → replaced by configured `lora.hop_limit` (since 2.7.x, `Router::sendLocal`). |
| `want_ack` | 10 | bool | Forced false on broadcasts. Unicast: up to 3 retransmissions (`NUM_RELIABLE_RETX`), ACK/NAK arrives as a `ROUTING_APP` packet with `decoded.request_id = id`. |
| `priority` | 11 | optional | `UNSET` → firmware picks. |
| `public_key` | 16 | optional, 32 bytes | Only checked when `pki_encrypted` is set: must match the stored key of `to`, else `PKI_FAILED`. |
| `pki_encrypted` | 17 | optional | Force PKC. If PKC is not possible → `Routing.Error PKI_FAILED (34)`. |
| `next_hop`, `relay_node` | 18, 19 | never | Firmware zeroes them. |

`Data` fields: `portnum (1)`, `payload (2)`, `want_response (3)`, `dest (4)`, `source (5)`,
`request_id (6)` (fixed32, set on responses/ACKs), `reply_id (7)`, `emoji (8)`,
`bitfield (9)` (firmware-owned, see §17), `xeddsa_signature (10)` (2.8+, firmware-owned; cleared
by firmware on packets it originates).

Responses to a request arrive as an ordinary `FromRadio.packet` with `decoded.request_id` equal
to the request's `MeshPacket.id`. Errors arrive as `ROUTING_APP` packets
(`Routing.error_reason (3)`) with the same `request_id`.

### 0.2 want_response semantics (`MeshModule::callModules`)

For a decoded packet with `want_response = true` addressed to the node (unicast to it, or
broadcast):

1. Each module registered for the portnum gets `allocReply()`; the first non-null reply is sent
   (only one reply per request). Reply gets `to = requester`, `channel = request channel`,
   `want_ack = request.want_ack`, `request_id = request.id`, priority `RELIABLE` unless set, and
   `hop_limit = RoutingModule::getHopLimitForResponse()` (hops the request used + 2, capped at the
   configured hop limit; if the request used more hops than the limit, the same count; 0 if the
   request had `hop_start == 0`).
2. If no module replied and none set `ignoreRequest`, the node sends `Routing.error_reason =
   NO_RESPONSE (8)` back to the requester.
3. If a module set `ignoreRequest` (throttles below), **nothing** is sent — the client sees
   silence, not a NAK. Clients must time out.

A module that does not exist on the target (disabled module not instantiated, platform does not
have it) produces `NO_RESPONSE (8)`.

### 0.3 Client-side rate limits in the node (`PhoneAPI::handleToRadioPacket`)

Per client connection (timestamps are per `PhoneAPI` instance, per portnum, not per destination).
Same in 2.7.15, 2.7.26, 2.8.0.

| Portnum | Minimum interval | On violation |
|---|---|---|
| `TRACEROUTE_APP (70)` | 30 s | Dropped. `ClientNotification{level=WARNING, reply_id=id, "TraceRoute can only be sent once every 30 seconds"}` + `QueueStatus{res=0, mesh_packet_id=id}`. |
| `TRACEROUTE_APP` to broadcast with `hop_limit > 0` | always refused | Dropped. Notification "Multi-hop traceroute to broadcast address is not allowed" + QueueStatus. |
| `POSITION_APP (3)`, `WAYPOINT_APP (8)`, `ALERT_APP (11)`, `TELEMETRY_APP (67)` | 10 s | Dropped silently except `QueueStatus{res=0, mesh_packet_id=id}`. |
| `TEXT_MESSAGE_APP (1)` | 2 s | Dropped. QueueStatus + `Routing.error_reason = RATE_LIMIT_EXCEEDED (38)` with `request_id = id`. |

2.7.x records the timestamp for every portnum, 2.8.0 only for the six listed ports. A dropped
packet does not update the timestamp. Admin (`ADMIN_APP`) and `NEIGHBORINFO_APP` are not
rate-limited at this layer.

The TX path additionally aborts with `DUTY_CYCLE_LIMIT (9)` (plus a ClientNotification) when the
region duty cycle is exceeded and `lora.override_duty_cycle` is false (`Router::send`).

### 0.4 Channel vs PKC encryption (`Router::perhapsEncode`, `wouldEncryptWithPKC` in 2.8)

A packet the node originates is PKC-encrypted (X25519 + AES-256-CCM, 12 bytes overhead:
8-byte tag + 4-byte extra nonce; `CryptoEngine::encryptCurve25519`) when **all** hold:

- not licensed (`owner.is_licensed == false`);
- own `security.private_key` is 32 bytes;
- `to` is not a broadcast;
- portnum is **not** `TRACEROUTE_APP`, `NODEINFO_APP`, `ROUTING_APP`, `POSITION_APP`
  (2.8 also: not `KEY_VERIFICATION_APP` while no key is known);
- channel name is not `serial`/`gpio` unless `pki_encrypted` was requested.

Then:

| Destination public key known? | 2.7.15–2.7.18 | 2.7.19+ incl. 2.7.26, 2.8.0 |
|---|---|---|
| yes | PKC, `channel` on air = 0, `pki_encrypted = true` | same |
| no | falls back to channel (AES-CTR) encryption | **refused**: `Routing.error_reason = PKI_SEND_FAIL_PUBLIC_KEY (39)` to the client |

Consequence for 2.7.19+: unicast text, telemetry requests, neighbour-info requests and remote
admin to a node whose `User.public_key` the local node does not have fail with error 39. Fix:
obtain the key first (NodeInfo exchange, §6) or use a portnum excluded from PKC.

Receive side (`perhapsDecode`): PKC decrypt is attempted only when the on-air channel hash is 0,
the packet is to us, and both public keys are known. A received channel-encrypted (non-PKC)
`TEXT_MESSAGE_APP` unicast to us is **dropped** ("Rejecting legacy DM") unless we are licensed.

---

## 1. Traceroute

| Item | Value |
|---|---|
| Port | `TRACEROUTE_APP = 70` |
| Payload | `RouteDiscovery` (mesh.proto) |
| Request | unicast, `want_response = true`, payload = empty `RouteDiscovery` (0 bytes) |
| Response | `RouteDiscovery`, same port, `decoded.request_id = request.id` |
| Encryption | never PKC (excluded portnum) — always channel encryption |
| Firmware | `src/modules/TraceRouteModule.cpp`, `src/mesh/PhoneAPI.cpp`, `src/mesh/FloodingRouter.cpp` |

### 1.1 RouteDiscovery

| Field | # | Wire type | Max entries (nanopb) | Meaning |
|---|---|---|---|---|
| `route` | 1 | repeated fixed32 | 8 | Node nums that relayed the request (origin and destination excluded). |
| `snr_towards` | 2 | repeated int32 (packed) | 8 | SNR ×4 measured by each receiver of the request: one per `route` entry, then one for the destination. |
| `route_back` | 3 | repeated fixed32 | 8 | Node nums that relayed the response (destination and origin excluded). |
| `snr_back` | 4 | repeated int32 (packed) | 8 | SNR ×4 per `route_back` entry, then one measured by the origin. |

Also appears inside `Routing.route_request (1)` / `route_reply (2)` (legacy, not used by current
traceroute).

### 1.2 How the firmware fills it

`TraceRouteModule` is promiscuous: every node that decodes a traceroute packet (relay or endpoint)
runs `alterReceivedProtobuf()` before rebroadcasting.

Request direction (`decoded.request_id == 0`):
1. `insertUnknownHops`: `hopsTaken = hop_start - hop_limit`. If `hopsTaken > route_count`, append
   `0xFFFFFFFF` (`NODENUM_BROADCAST`, "unknown hop") until equal; then pad `snr_towards` with
   `INT8_MIN` (−128, "unknown SNR") until `snr_count == route_count`. Happens when a relay could not
   decode the packet (other channel/PSK) or ran firmware that does not append.
2. `appendMyIDandSNR`: append own `rx_snr × 4` to `snr_towards`; append own node num to `route`
   **unless** the packet is addressed to us (destination appends SNR only).

At the destination `allocReply()` returns the updated `RouteDiscovery` as the response.

Response direction (`request_id != 0`): same steps on `route_back` / `snr_back`; the origin appends
only its SNR.

### 1.3 SNR encoding

- Stored as `int8`, value = SNR_dB × 4 (0.25 dB resolution). Decode: `dB = v / 4`.
- `-128` (`INT8_MIN`) = unknown.
- 2.7.x: `(int8_t)(snr * 4)` — truncates toward zero, no clamp (values beyond ±31.75 dB wrap;
  unlikely in practice).
- 2.8.0: `clamp(lroundf(snr * 4), -127, 127)` — rounds, never produces −128 for a real value.
- On the wire the arrays are `int32` varints: negative values are 10-byte sign-extended varints.
  Decode as int64 → truncate to int32 (the repeated field may arrive packed or unpacked; accept
  both).

### 1.4 Rendering (as the firmware's own UI does)

```
forward:  origin → route[0] (snr_towards[0]) → … → route[n-1] (snr_towards[n-1]) → dest (snr_towards[n])
return :  dest → route_back[0] (snr_back[0]) → … → route_back[m-1] → origin (snr_back[m])
```
The SNR attached to a hop is what *that* node measured receiving the packet. Hop entry
`0xFFFFFFFF` = unknown relay; SNR −128 = unknown. Total hops = `len(route)+1` each way.

### 1.5 Behaviour, limits, refusals

| Rule | Where |
|---|---|
| Client may send one traceroute per 30 s per connection (§0.3). | `PhoneAPI::handleToRadioPacket` |
| Broadcast traceroute allowed only with `hop_limit = 0`. | same |
| Unicast traceroute from the client is upgraded to `want_ack = true`; the response copies `want_ack`. | same |
| Destination ignores (no reply, no NAK) a *broadcast* traceroute that has already been relayed (`hop_limit < hop_start`). | `TraceRouteModule::allocReply` |
| Max 8 hops recorded per direction; extra hops are not appended ("Route exceeded max hop limit"). | `appendMyIDandSNR` |
| Nodes on the request path learn `next_hop` for downstream nodes from the response (2.8 only if the response was relayed by that next hop). | `updateNextHops` |
| When MQTT encryption is on, the modified traceroute is re-encrypted before MQTT uplink (2.7.26+). | `Router::handleReceived` |
| Node's own on-screen traceroute (not the client path) has a separate 30 s cooldown. | `TraceRouteModule::startTraceRoute` |

Failure modes the client sees: `Routing` NAK `MAX_RETRANSMIT (5)` / `NO_ROUTE (1)` (want_ack
exhausted), `NO_RESPONSE (8)` if the destination has traceroute excluded at build time, or nothing
(timeout). No firmware-defined timeout; official apps use ~60 s (unverified).

---

## 2. Neighbor Info

| Item | Value |
|---|---|
| Port | `NEIGHBORINFO_APP = 71` |
| Payload | `NeighborInfo` |
| Config | `ModuleConfig.neighbor_info (10)` → `NeighborInfoConfig` (config.md) |
| Firmware | `src/modules/NeighborInfoModule.cpp`, `src/modules/Modules.cpp` |

### 2.1 Messages

`NeighborInfo`: `node_id (1) uint32` (reporting node), `last_sent_by_id (2) uint32` (last node that
(re)sent it; relays overwrite it with their own num), `node_broadcast_interval_secs (3) uint32`,
`neighbors (4) repeated Neighbor` (max 10).

`Neighbor`: `node_id (1) uint32`, `snr (2) float` (dB, last heard), `last_rx_time (3) fixed32` and
`node_broadcast_interval_secs (4) uint32` — the last two are local only, not sent.

### 2.2 What the node collects

- Module object exists only if `neighbor_info.enabled` (`Modules.cpp`). When enabled it is
  promiscuous: any packet with `hop_start - hop_limit == 0` (direct) adds/updates a neighbour with
  that packet's `rx_snr`; received `NeighborInfo` packets add `last_sent_by_id` as a neighbour.
- Neighbours not heard for 2 × their broadcast interval are dropped. Table max 10, oldest evicted.
- Periodic send: every `update_interval` (default 21600 s = 6 h; values below 14400 are replaced by
  21600 by `AdminModule::handleSetModuleConfig`). Sent as broadcast over LoRa only when
  `transmit_over_lora` is true **and** the primary channel is not the default channel (or not on
  the default frequency slot) **and** channel utilisation permits; otherwise sent to
  `NODENUM_BROADCAST_NO_LORA (1)` — i.e. delivered to the local client/MQTT only. Only sent when
  the table is non-empty. Priority BACKGROUND.

### 2.3 Requesting a remote node's neighbours

```
ToRadio.packet { to = target, channel = idx, want_ack = true?,
                 decoded { portnum = 71, payload = <NeighborInfo, may be empty>, want_response = true } }
```

| Target firmware / state | Result |
|---|---|
| 2.7.15 (and older) | No reply handler. Observed with the module disabled on 2.7.15: **no answer at all** (no `NO_RESPONSE`), so the request times out. |
| 2.7.16+ with `neighbor_info.enabled` | Reply `NeighborInfo` (its current table, `node_id = target`), `request_id = request.id`. |
| 2.7.16+, replied < 3 min ago (global, not per requester) | Silently ignored (no NAK). |
| module disabled (not instantiated) | `NO_RESPONSE (8)`. |
| 2.7.19+ sender without target public key | `PKI_SEND_FAIL_PUBLIC_KEY (39)` locally (NEIGHBORINFO is PKC-eligible). |

The request payload is decoded by the target's `handleReceivedProtobuf`; a request whose
`NeighborInfo` has exactly one neighbour with `node_id = 0, snr = 0` is treated as a dummy and not
merged. An empty payload is accepted (unverified whether it is merged as an edge from the
requester; harmless).

---

## 3. Range test

| Item | Value |
|---|---|
| Port | `RANGE_TEST_APP = 66` |
| Payload | ASCII text `"seq N"` (N = uint, increments per send) |
| Config | `ModuleConfig.range_test (5)` |
| Firmware | `src/modules/RangeTestModule.cpp` |

- Module exists only when `range_test.enabled`. Platforms: ESP32, nRF52, STM32WL, Portduino
  (`#if` in `runOnce`); excluded if GPS excluded at build time.
- `range_test.sender = S > 0`: node broadcasts `"seq N"` every S seconds, `hop_limit = 0`,
  `want_ack = false`, first packet 5 s after boot, only if channel utilisation < 25 %; stops
  automatically after 8 h uptime (`Throttle 28800000 ms`). `sender = 0` = receiver.
- Receiver with `save = true` appends to `/static/rangetest.csv` (ESP32), cleared on boot if
  `clear_on_reboot`.
- The client simply receives `RANGE_TEST_APP` packets (`loopbackOk = true`, so the sender's own
  packets are also shown locally). Use `rx_snr`, `rx_rssi`, `hop_start/hop_limit` of each packet.
- Not uplinked to the public MQTT server (`MQTT::onSend` drops `RANGE_TEST_APP` and
  `DETECTION_SENSOR_APP` when using the default server).
- No request/response.

---

## 4. Store & Forward

| Item | Value |
|---|---|
| Port | `STORE_FORWARD_APP = 65` |
| Payload | `StoreAndForward` (storeforward.proto) |
| Config | `ModuleConfig.store_forward (4)` |
| Firmware | `src/modules/StoreForwardModule.cpp` |

### 4.1 Message

`StoreAndForward`: `rr (1) RequestResponse`; oneof `variant`: `stats (2) Statistics`,
`history (3) History`, `heartbeat (4) Heartbeat`, `text (5) bytes`. master adds
`original_id (6) uint32` (not in 2.8.0).

`RequestResponse`: router→client `ROUTER_ERROR 1, ROUTER_HEARTBEAT 2, ROUTER_PING 3, ROUTER_PONG 4,
ROUTER_BUSY 5, ROUTER_HISTORY 6, ROUTER_STATS 7, ROUTER_TEXT_DIRECT 8, ROUTER_TEXT_BROADCAST 9`;
client→router `CLIENT_ERROR 64, CLIENT_HISTORY 65, CLIENT_STATS 66, CLIENT_PING 67,
CLIENT_PONG 68, CLIENT_ABORT 106`.

`Statistics`: `messages_total 1, messages_saved 2, messages_max 3, up_time 4 (s), requests 5,
requests_history 6, heartbeat 7 (bool), return_max 8, return_window 9 (minutes)`.
`History`: `history_messages 1, window 2, last_request 3`. `Heartbeat`: `period 1 (s),
secondary 2`.

### 4.2 Server conditions

Server mode only on ESP32/Portduino, when `store_forward.enabled` and (`is_server` or role
`ROUTER`/`ROUTER_LATE`), and the device has PSRAM with ≥ 1 MiB free. Stores only
`TEXT_MESSAGE_APP` packets it hears (broadcast or DM). Defaults: `history_return_max = 25`,
`history_return_window = 240` min, `records = 0` → ¾ of free PSRAM, heartbeat off
(`heartbeat = true` → `ROUTER_HEARTBEAT` broadcast every 900 s).

### 4.3 Requests (client → server node, unicast)

| Request | Payload | Server reply |
|---|---|---|
| History | `{rr = CLIENT_HISTORY (65), history = {window = minutes}}` (window 0 → server default) | First `ROUTER_HISTORY` with `history {history_messages = count (≤ return_max), window = ms (minutes×60000), last_request = index}`, then up to `count` packets, one per 5 s: `rr = ROUTER_TEXT_DIRECT (8)` or `ROUTER_TEXT_BROADCAST (9)`, `text = original bytes`, `MeshPacket.from = original sender`, `id = original id`, `rx_time = stored time`, `to = requester`. |
| Legacy history | `TEXT_MESSAGE_APP` payload `"SF\0"` unicast to server | same as history with default window |
| Stats | `{rr = CLIENT_STATS (66)}` | `ROUTER_STATS` with `stats`, or `ROUTER_BUSY (5)` |
| Ping | `{rr = CLIENT_PING (67)}` | `ROUTER_PONG (4)` |
| Abort | `{rr = CLIENT_ABORT (106)}` or `CLIENT_ERROR` | stops a running history send to that client |

Refusals:
- Request arriving on the **default channel** (`Channels::isDefaultChannel`: PSK index 1 and
  preset-derived name) or while busy → a `TEXT_MESSAGE_APP` DM to the requester:
  `"S&F not permitted on the public channel."` / `"S&F - Busy. Try again shortly."`.
- Only packets `from != requester` and (`to == broadcast` or `to == requester`) are replayed;
  per-requester index `lastRequest[]` means repeat requests continue where the last one stopped.
- Replay only while channel utilisation < 25 %.
- `want_response` is not used by S&F (all replies are separate packets, `want_response = false`).
- The server's *own* client receives stored history automatically via `getForPhone()` as plain
  `TEXT_MESSAGE_APP` packets.

---

## 5. Remote administration

| Item | Value |
|---|---|
| Port | `ADMIN_APP = 6` |
| Payload | `AdminMessage` (admin.proto) |
| Firmware | `src/modules/AdminModule.cpp` (`handleReceivedProtobuf`, `setPassKey`, `checkPassKey`, `messageIsRequest/Response`) |

### 5.1 Authorisation (in order, `AdminModule::handleReceivedProtobuf`)

| Case | Accepted when | Rejection |
|---|---|---|
| Message is a `get_*_response` | always (2.8: only if it answers an outstanding request we sent to that node — see §5.6) | ignored |
| `from == 0` (local client over serial/BLE/TCP) | `security.is_managed == false` | silently ignored when managed (2.7.x; 2.8 without access-control build) |
| Arrived on a channel named `admin` (case-insensitive) | `security.admin_channel_enabled == true` | `Routing NOT_AUTHORIZED (33)` |
| `pki_encrypted` | sender public key equals one of `security.admin_key[0..2]` (32 bytes each) | `Routing ADMIN_PUBLIC_KEY_UNAUTHORIZED (37)` |
| anything else | — | `Routing NOT_AUTHORIZED (33)` |

A successful PKC admin from node X auto-favourites X on the target (not when target role is
`CLIENT_BASE`; 2.8 also refuses when the protected-node cap is reached).

Local admin (`to = own node num`) needs no session key and no PKC.

### 5.2 session_passkey flow (remote only)

`AdminMessage.session_passkey (101) bytes` (8 bytes).

1. Client sends any **getter** (no key needed): e.g.
   `{get_config_request (5) = SESSIONKEY_CONFIG (8)}` or `{get_device_metadata_request (12) = true}`
   with `want_response = true`, unicast to the target, PKC (automatic when the target key is known).
2. Every response the target builds goes through `setPassKey()`: if no key exists, or the current
   key is older than **150 s**, a new random 8-byte key is generated (2.7.x `random()`; 2.8 hardware
   RNG / CSPRNG); the key is copied into the response's `session_passkey`.
3. Every **non-getter, non-response** message from a remote sender (`from != 0`) must carry the same
   8 bytes in `session_passkey`; `checkPassKey()` accepts it for **300 s** after the key was
   issued. Otherwise → `Routing ADMIN_BAD_SESSION_KEY (36)`.
4. There is one key per target node (not per requester). Any getter older than 150 s rotates it, so a
   client should re-read the key from each response and refresh it (cheap getter) before 300 s.
5. The getter list (`messageIsRequest`): `get_channel_request, get_owner_request,
   get_config_request, get_module_config_request, get_canned_message_module_messages_request,
   get_device_metadata_request, get_ringtone_request, get_device_connection_status_request,
   get_node_remote_hardware_pins_request, get_ui_config_request`. Everything else (all `set_*`,
   `begin/commit_edit_settings`, reboot, shutdown, factory reset, favourites, `set_time_only`, …)
   needs the key.

Note `get_ui_config_response` is returned without `setPassKey` (no key in it).

Response delivery: the target replies with `pki_encrypted = true` if the request was PKC. On
2.7.x/2.8 the responding packet reaches the client as a normal `FromRadio.packet` from the target
(`RoutingModule` forwards all to-us packets to the client regardless of `AdminModule`).

Getter replies are only produced when the request has `want_response = true`. Any admin request
with `want_response = true` that produced no specific reply gets `Routing.error_reason = NONE (0)`
(an application-level ACK) with `request_id = request.id`.

### 5.3 Admin keys and legacy admin channel

- `SecurityConfig.admin_key (3)`: up to 3 × 32-byte X25519 public keys allowed to administer this
  node over PKC. The administering node's own `User.public_key` must be in the target's list.
- `SecurityConfig.is_managed (4)`: when true, local (serial/BLE) admin is refused; setting it
  requires at least one admin key (else firmware clears it and sends warning
  "You must provide at least one admin public key to enable managed mode").
- `SecurityConfig.admin_channel_enabled (8)`: legacy mode — admin accepted from any node that
  shares a channel named `admin`. Default false. The sending node decides PKC vs channel
  encryption without regard to the channel name (§0.4): a 2.7.19+/2.8 sender that knows the target
  key sends PKC (target then checks `admin_key`, not the channel), and one that does not know the
  key refuses with error 39. So with current senders the legacy path is only reached from
  firmware ≤ 2.7.18 without the target key, or from licensed (ham) senders. Treat as deprecated.

### 5.4 AdminMessage variants

Field numbers from admin.proto. "Key" = needs `session_passkey` when remote. "Reboot" = target
reboots (7 s, `DEFAULT_REBOOT_SECONDS`) unless inside an edit transaction (§5.5).

| Variant | # | Type | Key | Reply | Reboot | Notes |
|---|---|---|---|---|---|---|
| `get_channel_request` | 1 | uint32 | no | `get_channel_response (2) Channel` | — | **index + 1** (1..8). Out of range → `BAD_REQUEST (32)`. |
| `get_owner_request` | 3 | bool | no | `get_owner_response (4) User` | — | |
| `get_config_request` | 5 | `ConfigType` | no | `get_config_response (6) Config` | — | ConfigType is **0-based** (`DEVICE_CONFIG=0 … SESSIONKEY_CONFIG=8, DEVICEUI_CONFIG=9`) while `Config` oneof tags are 1-based (device=1 … device_ui=10). Network `wifi_psk` returned as-is in 2.7.x; 2.8 returns `"sekrit"` to remote requesters. 2.8 strips `security.private_key` for remote requesters. |
| `get_module_config_request` | 7 | `ModuleConfigType` | no | `get_module_config_response (8) ModuleConfig` | — | 0-based enum: `MQTT_CONFIG=0 … PAXCOUNTER_CONFIG=12, STATUSMESSAGE_CONFIG=13 (2.7.26+), TRAFFICMANAGEMENT_CONFIG=14, TAK_CONFIG=15, MESHBEACON_CONFIG=16 (2.8)`. 2.7.26 firmware does not answer 14/15 (no case → empty response). |
| `get_canned_message_module_messages_request` | 10 | bool | no | `…_response (11) string` | — | Handled by CannedMessageModule, which exists only on builds with a screen and non-COLOR display mode; otherwise ACK only. |
| `get_device_metadata_request` | 12 | bool | no | `get_device_metadata_response (13) DeviceMetadata` | — | |
| `get_ringtone_request` | 14 | bool | no | `get_ringtone_response (15) string` | — | RTTTL, ExternalNotificationModule. |
| `get_device_connection_status_request` | 16 | bool | no | `…_response (17) DeviceConnectionStatus` | — | |
| `set_ham_mode` | 18 | `HamParameters` | yes | ACK | yes | Sets long_name = call_sign (2.8: `call_sign//long_name`), short_name, `is_licensed`, `override_duty_cycle`, `tx_power`, `override_frequency`, `node_info_broadcast_secs=600`, `rebroadcast_mode=LOCAL_ONLY`, clears all channel PSKs. 2.8: blank call_sign → `BAD_REQUEST`; call_sign `N0CALL` → `tx_enabled=false`. |
| `get_node_remote_hardware_pins_request` | 19 | bool | no | `…_response (20)` | — | |
| `enter_dfu_mode_request` | 21 | bool | yes | — | DFU | nRF52/RP2040 (2.8 + STM32). |
| `delete_file_request` | 22 | string | yes | — | — | path |
| `set_scale` | 23 | uint32 | yes | — | — | NAU7802 |
| `backup_preferences` | 24 | `BackupLocation` | yes | Routing NONE / BAD_REQUEST | — | FLASH=0, SD=1 |
| `restore_preferences` | 25 | `BackupLocation` | yes | Routing NONE / BAD_REQUEST | yes | |
| `remove_backup_preferences` | 26 | `BackupLocation` | yes | — | — | |
| `send_input_event` | 27 | `InputEvent` | yes | — | — | `event_code 1, kb_char 2, touch_x 3, touch_y 4` |
| `set_owner` | 32 | `User` | yes | ACK / `BAD_REQUEST` | yes, if anything changed | Empty long/short name = keep current; whitespace-only = `BAD_REQUEST`. long_name max 39 bytes (2.7.x), 24 bytes (2.8, UTF-8 safe clamp). short_name max 4 bytes. `is_unmessagable` honoured only if present. |
| `set_channel` | 33 | `Channel` | yes | ACK / `BAD_REQUEST` | **no** | index 0–7. Setting role PRIMARY demotes the old primary to SECONDARY. Licensed owner → PSKs forced empty. |
| `set_config` | 34 | `Config` (one variant) | yes | ACK | per section, see config.md §2.3 | 2.8: `LORA_24` region on a radio without 2.4 GHz → `BAD_REQUEST`. |
| `set_module_config` | 35 | `ModuleConfig` (one variant) | yes | ACK / `BAD_REQUEST` | yes except statusmessage, mesh_beacon | `BAD_REQUEST` if MQTT/serial validation fails. |
| `set_canned_message_module_messages` | 36 | string | yes | — | — | pipe-separated (`\|`), ≤ 200 bytes |
| `set_ringtone_message` | 37 | string | yes | — | — | RTTTL ≤ 230 bytes |
| `remove_by_nodenum` | 38 | uint32 | yes | — | — | Deletes node from NodeDB. |
| `set_favorite_node` | 39 | uint32 | yes | — | — | Only if node is in NodeDB. 2.8: refused (warning to local client) when protected-node cap (`MAX_NUM_NODES-2`) reached. |
| `remove_favorite_node` | 40 | uint32 | yes | — | — | |
| `set_fixed_position` | 41 | `Position` | yes | — | — | Sets own position, `position.fixed_position = true`, broadcasts position. |
| `remove_fixed_position` | 42 | bool | yes | — | — | Clears position, `fixed_position = false`. |
| `set_time_only` | 43 | fixed32 | yes | — | — | Unix seconds → RTC at quality NTP (`perhapsSetRTC(RTCQualityNTP)`); ignored if the node already has better/equal time source per RTC rules. |
| `get_ui_config_request` | 44 | bool | no | `get_ui_config_response (45) DeviceUIConfig` | — | |
| `store_ui_config` | 46 | `DeviceUIConfig` | yes | — | — | Writes `/prefs/uiconfig.proto` (2.8: only builds with a screen). |
| `set_ignored_node` | 47 | uint32 | yes | — | — | Sets ignored, wipes stored position/metrics/public key. 2.7.x: only if node exists. 2.8: creates the entry if absent, also deletes stored messages; protected-node cap applies. |
| `remove_ignored_node` | 48 | uint32 | yes | — | — | |
| `toggle_muted_node` | 49 | uint32 | yes | — | — | 2.7.26+ (not 2.7.15). Toggles NodeInfo `is_muted`. |
| `begin_edit_settings` | 64 | bool | yes | — | — | §5.5 |
| `commit_edit_settings` | 65 | bool | yes | — | yes (always) | §5.5 |
| `add_contact` | 66 | `SharedContact` | yes | — | — | `node_num 1, user 2, should_ignore 3, manually_verified 4` |
| `key_verification` | 67 | `KeyVerificationAdmin` | yes | — | — | KeyVerificationModule |
| `factory_reset_device` | 94 | int32 | yes | — | yes | Config + NodeDB + BLE bonds. |
| `reboot_ota_seconds` | 95 | int32 | yes | — | — | 2.7.15 only; deprecated 2.7.17, no handler in 2.7.26+. |
| `exit_simulator` | 96 | bool | — | — | — | Portduino only. |
| `reboot_seconds` | 97 | int32 | yes | — | yes | Reboot after N s; N < 0 cancels. |
| `shutdown_seconds` | 98 | int32 | yes | — | — | Power off after N s; N < 0 cancels. |
| `factory_reset_config` | 99 | int32 | yes | — | yes | Config reset, BLE bonds kept. |
| `nodedb_reset` | 100 | bool | yes | — | yes | `true` = keep favourites. Roles CLIENT_BASE/ROUTER/ROUTER_LATE always keep favourites. |
| `ota_request` | 102 | `OTAEvent` | yes | — | yes (1 s) | 2.7.17+ ESP32. `reboot_ota_mode 1 (OTA_BLE=1, OTA_WIFI=2)`, `ota_hash 2` (32 bytes, else refused with warning). |
| `sensor_config` | 103 | `SensorConfig` | yes | — | — | 2.7.26+, sensor calibration (SCD4X, SEN5X, SCD30, SHTXX; 2.8 adds DS248X, SEN6X, AS3935). |
| `lockdown_auth` | 104 | `LockdownAuth` | local | `FromRadio.lockdown_status (18)` | — | Hardened builds only (`MESHTASTIC_ENCRYPTED_STORAGE`). |

`session_passkey (101)` sits outside the oneof and may accompany any variant.

### 5.5 Edit transactions

- `begin_edit_settings` → `hasOpenEditTransaction = true`: subsequent `set_config`,
  `set_module_config`, `set_owner`, `set_channel` apply in RAM, do not save, do not reboot and do
  not disable Bluetooth.
- `commit_edit_settings` → saves config, module config, device state, channels and NodeDB, then
  **always reboots** (`saveChanges(..., shouldReboot=true)`), even if only no-reboot fields changed.
- 2.8: an open transaction with no admin activity for 60 s (`EDIT_TRANSACTION_IDLE_MS`) is
  auto-closed on the next admin message: deferred segments are saved **without** reboot.
- 2.7.x: no timeout; an abandoned transaction leaves later writes unsaved until reboot.
- The flag is global on the node, not per client.

### 5.6 Requesting config of a remote node (recipe)

1. Ensure the local node has the target's `User.public_key` (NodeInfo, §6) and the local node's
   public key is in the target's `admin_key` list (or legacy admin channel is enabled on both).
2. For each section: `{get_config_request = k}` (k = 0..7, 9) / `{get_module_config_request = k}` /
   `{get_channel_request = i+1}` / `{get_owner_request = true}`, `want_response = true`,
   `to = target`, `channel = 0`, unique `id`. Wait for `get_*_response` with
   `request_id = id` (or a Routing error with the same `request_id`).
3. Space requests (a few seconds) — every request/response is a full mesh round trip; there is no
   firmware-side batching.
4. Keep the newest `session_passkey` from the responses; use it in `set_*` within 300 s.
5. 2.8 targets/senders: the local 2.8 node only lets its own `AdminModule` accept a response that
   matches an outstanding request (same target, same response variant, same `request_id`, within
   300 s, one response per request, PKC key pinned). This affects the node's internal handling;
   the packet is still forwarded to the client. Always send a fresh `id` per request.

### 5.7 Reboot / shutdown / factory reset summary

| Action | Variant | Value |
|---|---|---|
| Reboot in N s | `reboot_seconds (97)` | N ≥ 0; N < 0 cancels |
| Shutdown in N s | `shutdown_seconds (98)` | N ≥ 0; N < 0 cancels |
| Factory reset (keep BLE bonds) | `factory_reset_config (99)` | any int32 (value unused) |
| Factory reset all | `factory_reset_device (94)` | any int32 |
| Reset NodeDB | `nodedb_reset (100)` | bool keep-favourites |
| Reboot to OTA loader | `ota_request (102)` (2.7.17+), `reboot_ota_seconds (95)` (≤2.7.16) | |
| DFU (UF2) | `enter_dfu_mode_request (21)` | |

After a reboot the serial client sees `FromRadio.rebooted (8)` and must re-run `want_config`.

---

## 6. NodeInfo exchange and public keys

| Item | Value |
|---|---|
| Port | `NODEINFO_APP = 4` |
| Payload | `User` |
| Encryption | never PKC (excluded) |
| Firmware | `src/modules/NodeInfoModule.cpp`, `src/mesh/MeshService.cpp`, `src/mesh/NodeDB.cpp` |

`User`: `id (1) string` (`"!%08x"` of node num; receivers overwrite it), `long_name (2)`,
`short_name (3)`, `macaddr (4)` deprecated, `hw_model (5) HardwareModel`, `is_licensed (6) bool`,
`role (7) Config.DeviceConfig.Role`, `public_key (8) bytes(32)`, `is_unmessagable (9) optional
bool`.

Requesting a node's User: send own `User` (the node fills it — a client can send any `User`
payload; the receiver only uses the requester's packet to update its DB) to the target with
`want_response = true`. Target behaviour (`allocReply`):

| Condition | Result |
|---|---|
| Target heard a `want_response` NodeInfo from this requester < 12 h ago (since 2.7.17, `USERPREFS_NODEINFO_REPLY_SUPPRESS_SECS`) | ignored (no NAK) |
| Channel utilisation > 40 % | ignored |
| Target sent its NodeInfo within the scaled 10 min window (2.7.17+; 5 min in 2.7.15) | ignored |
| `is_licensed` of request ≠ target's | request dropped |
| otherwise | reply `User` (licensed owners send no `public_key`) |

Note the 12 h rule counts *requests*, so a client that re-requests the same node frequently gets
silence. The node itself auto-sends NodeInfo (want_response) to any newly heard node without a
`User` (not for ROUTER/ROUTER_LATE/CLIENT_BASE roles, if channel util < 25 %, within hop_limit+2
hops). Telemetry responses (`request_id > 0`) do not trigger this.

Periodic broadcast: every `device.node_info_broadcast_secs` (default 10800, min 3600), not for
`CLIENT_HIDDEN`; with `want_response = true` only after a channel/radio change.

2.8: node number = CRC32 of the node's own public key (`NodeDB::createNewIdentity`), applied at
boot and on key changes; a node upgraded from 2.7 may come up with a **different node number**.
A receiving 2.8 node verifies first-contact NodeInfo (`crc32(public_key) == from` and XEdDSA
signature) when signatures are present. Clients should key contacts by node num but expect
renumbering on 2.7→2.8 upgrades (CRC32 variant: ErriezCRC32 library, unverified which polynomial
settings).

---

## 7. Position requests and position precision

| Item | Value |
|---|---|
| Port | `POSITION_APP = 3` |
| Payload | `Position` |
| Encryption | never PKC (excluded) |
| Firmware | `src/modules/PositionModule.cpp`, `src/mesh/PositionPrecision.cpp` (2.7.24+), `src/mesh/Router.cpp` |

`Position` fields: `latitude_i 1 sfixed32 (1e-7°)`, `longitude_i 2`, `altitude 3 int32 (m MSL)`,
`time 4 fixed32`, `location_source 5`, `altitude_source 6`, `timestamp 7`,
`timestamp_millis_adjust 8`, `altitude_hae 9 sint32`, `altitude_geoidal_separation 10 sint32`,
`PDOP 11`, `HDOP 12`, `VDOP 13` (1/100), `gps_accuracy 14 (mm)`, `ground_speed 15 (km/h…)`,
`ground_track 16 (1/100°)`, `fix_quality 17`, `fix_type 18`, `sats_in_view 19`, `sensor_id 20`,
`next_update 21`, `seq_number 22`, `precision_bits 23`.

### 7.1 Requesting a position

Unicast `POSITION_APP` with `want_response = true`. Payload: own position (official apps) or an
empty `Position`. A unicast from the client is **not** processed locally, so an empty payload does
not clobber the local node's position; a **broadcast** position from the client *is* processed
locally and updates the node's own position (that is how phone GPS feeds a node), unless
`fixed_position` is set (then only time is taken).

Target (`PositionModule::allocReply`):

| Condition | Result |
|---|---|
| replied < 3 min ago (any requester), role ≠ LOST_AND_FOUND | ignored |
| channel the request arrived on has precision 0 (location sharing off) | no reply → `NO_RESPONSE (8)` |
| no valid position (lat = lon = 0) | `NO_RESPONSE (8)` |
| otherwise | `Position` truncated to that channel's precision, `precision_bits` set |

Client-side limit: one `POSITION_APP` per 10 s (§0.3).

### 7.2 Position precision

`ChannelSettings.module_settings (7)` → `ModuleSettings.position_precision (1)` (bits, 0–32).

- 0 = never send position on this channel. 32 = full precision. 1–31 = keep the top N bits of
  `latitude_i`/`longitude_i` (as uint32), then add `1 << (31 - N)` (centre of the cell).
  Cell edge = 2^(32−N) × 1e-7°; north-south size ≈ that × 111.32 km (east-west shrinks with
  cos(lat)); max error ≈ half the cell:

  | N | cell (°) | cell N-S | | N | cell (°) | cell N-S |
  |---|---|---|---|---|---|---|
  | 10 | 0.4194 | 46.7 km | | 15 | 0.0131 | 1.46 km |
  | 11 | 0.2097 | 23.3 km | | 16 | 0.0066 | 730 m |
  | 12 | 0.1049 | 11.7 km | | 17 | 0.0033 | 365 m |
  | 13 (2.7.x factory ch 0) | 0.0524 | 5.84 km | | 18 | 0.0016 | 182 m |
  | 14 | 0.0262 | 2.92 km | | 19 | 0.0008 | 91 m |
- `precision_bits (23)` in the sent Position = N.
- NodeDB positions sent to the client (`FromRadio.node_info`) **lack `precision_bits`**:
  `TypeConversions::ConvertToPosition` copies only lat/lon/alt/time/location_source (2.7.26),
  although `PositionLite.precision_bits (6)` is stored. Only live `POSITION_APP` packets carry it.
  N can be recovered: a truncated coordinate has its lowest set bit at 31 − N in both
  `latitude_i` and `longitude_i`. An exact position matches that by chance with probability
  4^−(31−N); meshmash infers N only for 31 − N ≥ 8 (N ≤ 23, cell ≥ 5.7 m).
- Missing `module_settings`: 2.7.15–2.7.23 treat PRIMARY as 32 (full) and secondaries as 0;
  2.7.24+ (`PositionPrecision.cpp`) treat any channel without module_settings as **0**.
- 2.8: on channels whose effective key is publicly known (no PSK, 1-byte PSK, well-known names)
  precision is clamped to ≤ 15 bits (`MAX_POSITION_PRECISION_PUBLIC_KEY`), stored value rewritten
  on `set_channel` with warning; "event" channels force 0.
- Periodic broadcast goes out on the first channel (0..7) with precision ≠ 0.
- Since 2.7.24 `Router::send` also applies the channel precision to client-originated position
  packets (unicast included); 2.7.15 only truncated client positions on the local loop-back path.

---

## 8. Telemetry

| Item | Value |
|---|---|
| Port | `TELEMETRY_APP = 67` |
| Payload | `Telemetry` (telemetry.proto): `time (1) fixed32`, oneof `variant` |
| Firmware | `src/modules/Telemetry/*.cpp` |

| Variant | # | Message | Module answering requests | Module exists when |
|---|---|---|---|---|
| `device_metrics` | 2 | `DeviceMetrics` | DeviceTelemetryModule | `HAS_TELEMETRY` (all normal builds) |
| `environment_metrics` | 3 | `EnvironmentMetrics` | EnvironmentTelemetryModule | `telemetry.environment_measurement_enabled` or `environment_screen_enabled` |
| `air_quality_metrics` | 4 | `AirQualityMetrics` | AirQualityTelemetryModule | `air_quality_enabled` or `air_quality_screen_enabled` |
| `power_metrics` | 5 | `PowerMetrics` | PowerTelemetryModule | `power_measurement_enabled` or `power_screen_enabled` |
| `local_stats` | 6 | `LocalStats` | DeviceTelemetryModule | always (with device telemetry) |
| `health_metrics` | 7 | `HealthMetrics` | HealthTelemetryModule | MAX30102 or MLX90614 sensor detected |
| `host_metrics` | 8 | `HostMetrics` | — (Portduino broadcasts only; request handler is commented out) | Linux native |
| `traffic_management_stats` | 9 | `TrafficManagementStats` | — | proto 2.7.26+, sent by TrafficManagementModule (2.8) |
| `soil_water_metrics` | 11 | `SoilWaterMetrics` | — | protobufs master only |

### 8.1 Requesting

Send `Telemetry` whose oneof is set to the wanted variant with an **empty** sub-message, e.g.
device metrics = bytes `12 00` (field 2, length 0); local stats = `32 00`; environment = `1A 00`;
air quality = `22 00`; power = `2A 00`; health = `3A 00`. `want_response = true`, unicast (or to
own node num for local stats of the local node).

Each telemetry module checks the variant; the first matching module replies. Rules:

| Condition | Result |
|---|---|
| Variant's module not present on target | `NO_RESPONSE (8)` |
| Module present but no sensor data (`get…Telemetry` false) | `NO_RESPONSE (8)` |
| Broadcast request already relayed (`hop_limit < hop_start`) and target role not SENSOR/ROUTER/ROUTER_LATE | ignored (since 2.7.20) |
| Client sent another TELEMETRY_APP < 10 s ago | dropped locally (§0.3) |
| 2.7.19+ sender lacks target public key | `PKI_SEND_FAIL_PUBLIC_KEY (39)` (TELEMETRY is PKC-eligible) |

No per-target reply throttle for telemetry requests.

### 8.2 Notes on values

- `DeviceMetrics.battery_level`: 0–100 %, **101** = external power / no battery
  (`MAGIC_USB_BATTERY_LEVEL`). `voltage` in V (2.8 omits it when no battery reading).
  `channel_utilization`, `air_util_tx` in %. `uptime_seconds`.
- `LocalStats`: `uptime_seconds 1, channel_utilization 2, air_util_tx 3, num_packets_tx 4,
  num_packets_rx 5, num_packets_rx_bad 6, num_online_nodes 7 (heard in last 2 h),
  num_total_nodes 8, num_rx_dupe 9, num_tx_relay 10, num_tx_relay_canceled 11,
  heap_total_bytes 12, heap_free_bytes 13, num_tx_dropped 14, noise_floor 15 (dBm, int32;
  2.7.26+)`.
- `EnvironmentMetrics`: 1 temperature °C, 2 relative_humidity %, 3 barometric_pressure hPa,
  4 gas_resistance MΩ, 5 voltage V, 6 current, 7 iaq 0–500, 8 distance mm, 9 lux, 10 white_lux,
  11 ir_lux, 12 uv_lux, 13 wind_direction °, 14 wind_speed m/s, 15 weight kg, 16 wind_gust,
  17 wind_lull, 18 radiation µR/h, 19 rainfall_1h mm, 20 rainfall_24h mm, 21 soil_moisture %,
  22 soil_temperature °C, 23 one_wire_temperature (repeated, 2.7.26 proto; deprecated 2.8),
  24–31 adc_voltage_ch0–7 V (2.8), 32–39 one_wire_temperature_ch0–7 °C (2.8),
  40 lightning_strike_count_1h, 41 lightning_distance_km (2.8).
- `PowerMetrics`: ch1–ch3 voltage/current (fields 1–6); ch4–ch8 (7–16) deprecated in 2.8 proto.
- `AirQualityMetrics`: 1–3 pm10/25/100_standard µg/m³, 4–6 environmental, 7–12 particle counts
  per 0.1 L, 13 co2 ppm, 14 co2_temperature, 15 co2_humidity, 16–18 formaldehyde, 19 pm40_standard,
  20 particles_40um, 21 pm_temperature, 22 pm_humidity, 23 pm_voc_idx, 24 pm_nox_idx,
  25 particles_tps µm, 26 pm_status_flags (2.8).
- `HealthMetrics`: 1 heart_bpm, 2 spO2 %, 3 temperature °C.
- `HostMetrics`: 1 uptime_seconds, 2 freemem_bytes, 3 diskfree1_bytes, 4–5 diskfree2/3,
  6–8 load1/5/15 (×100), 9 user_string.
- Most metric fields are `optional` (explicit presence): absent ≠ 0.

Periodic broadcasts: device metrics every `telemetry.device_update_interval` when
`device_telemetry_enabled` (default interval `INT32_MAX` from `initModuleConfigIntervals`, i.e.
off); the local client receives device metrics about once a minute regardless. Intervals are
scaled up when > 40 nodes are online (`Default::getConfiguredOrDefaultMsScaled`). 2.8's upgrade
migration turns all telemetry broadcast flags off once (config.md §5.1). Device-metrics and
local-stats requests are still answered (module always present); environment/air-quality/power
requests then get `NO_RESPONSE` unless the matching `*_screen_enabled` flag keeps the module
alive (after the next reboot).

---

## 9. Waypoints

| Item | Value |
|---|---|
| Port | `WAYPOINT_APP = 8` |
| Payload | `Waypoint` |
| Firmware | `src/modules/WaypointModule.cpp` |

`Waypoint`: `id 1 uint32`, `latitude_i 2 optional sfixed32`, `longitude_i 3 optional sfixed32`,
`expire 4 uint32 (epoch s)`, `locked_to 5 uint32 (node num allowed to edit; 0 = anyone)`,
`name 6 string (≤ 29 bytes)`, `description 7 string (≤ 99 bytes)`, `icon 8 fixed32 (Unicode code
point)`; 2.8 adds `geofence_radius 9 uint32 (m)`, `bounding_box 10 BoundingBox
{longitude_west_i 1, latitude_south_i 2, longitude_east_i 3, latitude_north_i 4}`,
`notify_on_enter 11`, `notify_on_exit 12`, `notify_favorites_only 13`.

- Usually broadcast on a channel. Update = resend with same `id`. Delete convention (apps): resend
  with `expire` in the past (unverified; firmware only stops displaying when `expire <= now`).
- Firmware does not enforce `locked_to`; enforcement is a client convention.
- Firmware stores only the last received waypoint (`devicestate.rx_waypoint`) for its screen.
- Client limit: one WAYPOINT_APP per 10 s.
- No request/response.

---

## 10. Detection sensor

| Item | Value |
|---|---|
| Port | `DETECTION_SENSOR_APP = 10` |
| Payload | UTF-8 text |
| Config | `ModuleConfig.detection_sensor (12)` |
| Firmware | `src/modules/DetectionSensorModule.cpp` |

- Module exists only if enabled. Polls `monitor_pin`; on trigger sends `"<name> detected"` (+ BEL
  `0x07` if `send_bell`), rate-limited by `minimum_broadcast_secs` (default 45); every
  `state_broadcast_secs` (0 = off) sends `"<name> state: 0|1"`.
- Broadcast on the primary channel, `want_ack = false`; **not sent at all** if channel 0 is the
  default (public) channel.
- Not uplinked to the public MQTT server.
- Clients display it like a text message (it is not `TEXT_MESSAGE_APP`).

---

## 11. Paxcounter

| Item | Value |
|---|---|
| Port | `PAXCOUNTER_APP = 34` |
| Payload | `Paxcount { wifi 1 uint32, ble 2 uint32, uptime 3 uint32 }` |
| Config | `ModuleConfig.paxcounter (13)` |
| Firmware | `src/modules/esp32/PaxcounterModule.cpp` |

ESP32 only; module exists only if enabled. Broadcasts every `paxcounter_update_interval`
(default 3600 s, scaled with mesh size). Answers `want_response` requests with current counts
(`allocReply`). Counting uses WiFi/BLE scanning (WiFi and BLE radios are shared with the node's
own connectivity, unverified impact).

---

## 12. Canned messages

- Stored list: `AdminMessage.set_canned_message_module_messages (36)` string, messages separated
  by `|`, ≤ 200 bytes (`cannedmessages.pb.h messages[201]`), max 50 entries parsed.
- Read: `get_canned_message_module_messages_request (10)` → `…_response (11)`.
- Handled by `CannedMessageModule` (`handleAdminMessageForModule`), present only on builds with a
  screen (`HAS_SCREEN`) and `display.displaymode != COLOR`. Elsewhere set/get produce only the
  generic ACK.
- Input wiring is `ModuleConfig.canned_message (7)` (config.md). `enabled (9)` and
  `allow_input_source (10)` are deprecated.
- Messages sent from canned messages are normal `TEXT_MESSAGE_APP` (plus BEL if `send_bell`).

---

## 13. MQTT-related flags

| Flag | Where | Meaning |
|---|---|---|
| `MeshPacket.via_mqtt (14)` | packet | Packet passed through MQTT somewhere on its path. Carried in the on-air header flags. Nodes with `lora.ignore_mqtt = true` drop such packets on receive (`Router::handleReceived`). MQTT never re-publishes packets that came from MQTT. |
| `NodeInfo.via_mqtt (8)` | NodeDB | Node was last heard via MQTT. |
| `Data.bitfield (9)` bit 0 `OK_TO_MQTT` | packet | Set by the originating node from `lora.config_ok_to_mqtt` (default false). A gateway publishing to a **public** broker does not uplink other nodes' packets lacking this bit (or lacking `bitfield`). Private brokers ignore the bit. |
| `Data.bitfield` bit 1 `WANT_RESPONSE` | packet | Mirror of `want_response`, set by originator; receivers OR it into `want_response`. |
| `LoRaConfig.config_ok_to_mqtt (105)` | config | Source of bit 0 for own packets. |
| `LoRaConfig.ignore_mqtt (104)` | config | Drop received `via_mqtt` packets. Firmware sets it to true when the region is first set to one with duty cycle < 100 %. |
| `ChannelSettings.uplink_enabled (5)` / `downlink_enabled (6)` | channel | Per-channel MQTT bridging. PKC DMs are uplinked to topic `…/PKI/…` when any channel has uplink enabled. |

Public-server restrictions (`MQTT::onSend`): `RANGE_TEST_APP` and `DETECTION_SENSOR_APP` never
uplinked to the default server.

---

## 14. PKI-encrypted direct messages

| Item | Value |
|---|---|
| Key exchange | `User.public_key (8)` (32-byte X25519) learned from NodeInfo; own key in `SecurityConfig.public_key (1)` |
| Shared key | SHA-256(X25519(own_private, peer_public)) |
| Cipher | AES-256-CCM, 8-byte tag, nonce from packet id + from + random 32-bit extra nonce appended to ciphertext (`CryptoEngine::encryptCurve25519`); total overhead 12 bytes |
| On air | `channel` hash = 0 |
| To client | `MeshPacket.pki_encrypted (17) = true`, `public_key (16)` = sender key |

Rules for a client:
- Send DMs normally (`to = node`, `TEXT_MESSAGE_APP`); firmware picks PKC (§0.4). Optionally set
  `pki_encrypted = true` and `public_key` to require PKC with an expected key (key mismatch →
  `PKI_FAILED (34)`).
- 2.7.19+: no key → `PKI_SEND_FAIL_PUBLIC_KEY (39)`; message not sent. Older firmware sends it on
  the channel instead.
- Receiver error `PKI_UNKNOWN_PUBKEY (35)`: sent by the destination (`ReliableRouter`) when a
  `want_ack` packet to it arrives with channel hash 0 (PKC) but it has no public key for the
  sender. When the sender's node gets this NAK it automatically sends its NodeInfo to that node
  (60 s throttle path), so a retry shortly after usually succeeds.
- A `want_ack` packet to us that cannot be decrypted at all → `NO_CHANNEL (6)` NAK.
- Payload limit: Data ≤ `233 - 12` bytes when PKC (`TOO_LARGE (7)` otherwise).
- Channel-encrypted DMs to a 2.7.x/2.8 node are dropped by the receiver ("legacy DM").
- 2.8 adds XEdDSA signatures on broadcasts (`Data.xeddsa_signature (10)`,
  `MeshPacket.xeddsa_signed (22)`, `NodeInfo.has_xeddsa_signed (14)`), receive policy
  `SecurityConfig.packet_signature_policy (9)`.
- Key regeneration: `set_config.security` with empty `private_key` → new keypair (2.7.x
  regenerates whenever private_key is not 32 bytes; 2.8 keeps the existing key unless a new
  32-byte key is supplied — see config.md §3.8). On 2.8 this changes the node number.

---

## 15. Favourite / ignore / remove / mute

All are `AdminMessage` uint32 variants carrying the node num (§5.4): `set_favorite_node 39`,
`remove_favorite_node 40`, `set_ignored_node 47`, `remove_ignored_node 48`, `remove_by_nodenum
38`, `toggle_muted_node 49` (2.7.26+). Local use needs no key. No reply unless `want_response`
(then Routing NONE). The new state shows in `NodeInfo.is_favorite (10)`, `is_ignored (11)`,
`is_muted (13)` on the next `want_config`; the firmware does not push an updated NodeInfo.

Effects:
- favourite: kept across `nodedb_reset(true)`; `CLIENT_BASE` role treats traffic to/from favourites
  as `ROUTER_LATE`; ROUTER/ROUTER_LATE/CLIENT_BASE preserve hops via favourites.
- ignored: packets from the node are dropped; position, metrics and public key are wiped.
- removed: entry deleted; it reappears when heard again.

---

## 16. set_time_only

`AdminMessage.set_time_only (43) fixed32` Unix seconds. Applied with `RTCQualityNTP` via
`perhapsSetRTC`. Remote use requires the session key. Alternative: a broadcast `POSITION_APP`
from the client with `time` set (also sets time, quality NTP for local packets) — but that also
overwrites the node's position unless `fixed_position` is set.

---

## 17. Want_config handshake (context)

`ToRadio.want_config_id (3) = nonce`. Special nonces: `69420` = config only (skip other nodes),
`69421` = nodes only. Order of `FromRadio` items:

| Step | 2.7.x | 2.8.0 |
|---|---|---|
| 1 | `my_info (3)` | same |
| 2 | `deviceuiConfig (17)` (if present) | same |
| 3 | own `node_info (4)` | same |
| 4 | `metadata (13)` | same |
| 5 | `channel (10)` × 8 | **`region_presets (19)`** then `channel` × 8 |
| 6 | `config (5)` per section | same |
| 7 | `moduleConfig (9)` per section | same |
| 8 | other `node_info` | same |
| 9 | `fileInfo (15)` manifest | same |
| 10 | `config_complete_id (7) = nonce` | same (+ `lockdown_status (18)` on hardened builds) |

`region_presets` = `LoRaRegionPresetMap { groups (1) repeated LoRaPresetGroup {presets (1) repeated
ModemPreset, default_preset (2), licensed_only (3)}, region_groups (2) repeated LoRaRegionPresets
{region (1), group_index (2)} }` — use it to restrict the preset picker per region.

---

## 18. Version differences that matter for a client

| Topic | 2.7.15 | 2.7.26 | 2.8.0 |
|---|---|---|---|
| Unicast without peer public key | channel-encrypted fallback | refused, error 39 (since 2.7.19) | refused, error 39 |
| Neighbour-info request reply | none (NO_RESPONSE) | reply, 3 min throttle (since 2.7.16) | same as 2.7.26 |
| NodeInfo request suppression | 5 min own-send window | + 12 h per requester (since 2.7.17), 10 min scaled window | same |
| Relayed broadcast telemetry request | answered | ignored unless SENSOR/ROUTER (since 2.7.20) | same |
| Traceroute SNR | `(int8)(snr*4)` | same | rounded, clamped ±127 |
| Position precision w/o module_settings | primary = full | 0 (since 2.7.24) | 0; public-key channels ≤ 15 bits |
| Default channel 0 precision (factory) | 13 | 13 | 0 (opt-in); upgrade migration sets public channels to 0 and turns telemetry broadcast flags off (config.md §5.1) |
| `toggle_muted_node`, `ota_request`, `sensor_config`, `STATUSMESSAGE_CONFIG` | absent | present | present |
| LoRa config change | reboot if radio params changed | same | applied live, no reboot |
| Security config change | never reboots (comparison bug) | never reboots | always reboots |
| Edit transaction timeout | none | none | 60 s idle → auto-save, no reboot |
| Remote `get_config(NETWORK)` wifi_psk | plain | plain | `"sekrit"` |
| Remote `get_config(SECURITY)` private_key | included | included | stripped |
| long_name limit | 39 bytes | 39 bytes | 24 bytes |
| Node number | MAC-derived | MAC-derived | CRC32(public key) — may change on upgrade |
| want_config | — | — | adds `FromRadio.region_presets (19)` before channels |
| Modem presets the firmware can actually run | 0–8 (LONG_TURBO not in its proto or param table) | 0–9 (10–13 exist in its proto but run with LONG_FAST parameters and display name "Invalid") | 0–16 (see config.md §3.6) |
| Admin responses accepted by own AdminModule | any | any | only solicited (§5.6) |
| Traffic management module | — | proto only | active by default except tiny MCUs |

---

## 19. Open items

- `modem_preset = 120` reported by a 2.8.0 node: **no such value exists** in any protobufs tag or
  firmware (`ModemPreset` ends at `MEDIUM_TURBO = 16` in 2.8.0 and master;
  `_meshtastic_Config_LoRaConfig_ModemPreset_MAX = 16` in `config.pb.h`). 120 (0x78) does appear
  as `HardwareModel.THINKNODE_M6`, but raw captured bytes confirm `LoRaConfig.modem_preset = 120`;
  most likely a fork-specific preset. See config.md §3.6.
- Official apps' traceroute/admin timeouts: not defined by firmware (unverified).
