# Paths, routing, path discovery, trace, binary requests

This document covers how MeshCore encodes paths and routes packets, and the companion
commands for path discovery, trace, neighbours, node discovery and raw sends.

Sources, at `companion-v1.17.1`:

- `src/Packet.h`, `src/Packet.cpp` (`isValidPathLen`, `writePath`)
- `src/Mesh.cpp` (`onRecvPacket` TRACE branch, `routeRecvPacket`, `sendFlood`, `sendDirect`,
  `createPathReturn`)
- `examples/companion_radio/MyMesh.cpp` (`CMD_SEND_TRACE_PATH`, `onTraceRecv`,
  `CMD_SEND_PATH_DISCOVERY_REQ`, `onContactPathRecv`)
- `examples/simple_repeater/MyMesh.cpp` (`REQ_TYPE_GET_NEIGHBOURS`, `onControlDataRecv`)

## 1. Path encoding (`path_len` byte)

Since 1.14 (`FIRMWARE_VER_CODE` 10), one byte packs both the hash size and the hop count:

```
path_len = ((hash_size - 1) << 6) | hop_count        hop_count = 0..63
hash_size = (path_len >> 6) + 1                       1, 2 or 3 bytes  (4 = reserved, invalid)
path byte length = hash_size * hop_count  (must be <= 64 = MAX_PATH_SIZE)
```

- `0xFF` (`OUT_PATH_UNKNOWN`) in a contact's `out_path_len` means **no known path, so
  messages are sent flood**. It would decode as size 4, which is reserved, so there is no
  clash.
- In received-message frames, `path_len == 0xFF` means **the packet arrived direct**. See
  companion-protocol.md, section 4.
- `path_len == 0` with direct routing means **zero-hop**: the packet reaches neighbours only
  and is not forwarded.
- Each hop entry is the first `hash_size` bytes of that repeater's public key.
- Each node uses its own `path_hash_mode` (0..2, so hash_size = mode+1) when it **originates**
  a flood. Repeaters append their own hash at the size already set in the packet. On a flood
  packet the hops are listed in the order they were traversed, starting nearest the origin.
- Older firmware (before 1.14) always uses size 1, so `path_len` is simply the hop count.
- 1.17.1 encodes the size in the same upper 2 bits. Some third-party notes describe this as
  new in 1.17; the source shows the scheme in `Packet.h` from ver code 10 (1.14) on.

Over-the-air packet layout (`Packet::writeTo`):

```
[header u8][transport_codes 2x u16 LE, only if route type 0 or 3][path_len u8][path bytes][payload]
```

Header bits:

- bits 0-1: route type. 0 = TRANSPORT_FLOOD, 1 = FLOOD, 2 = DIRECT, 3 = TRANSPORT_DIRECT.
- bits 2-5: payload type.
- bits 6-7: payload version.

## 2. Flood vs direct, and how a contact gets a path

- **Sending.** If `contact.out_path_len == 0xFF`, the companion sends flood. Otherwise it
  sends direct along `out_path`: each listed repeater removes its own hash and forwards.
  Floods go out "scoped" with transport codes whenever a flood scope key or default scope is
  set (see config.md).
- **Learning a path.** When a flood message or request reaches the destination, the
  destination answers with a `PAYLOAD_TYPE_PATH` packet (sent flood) carrying the inbound
  path, optionally piggy-backing an ACK or RESPONSE. The originator stores that path as
  `out_path`, emits `PUSH_PATH_UPDATED` (0x81, followed by the pubkey), and sends back a
  reciprocal PATH, sent direct, so the other side also learns its route. All of this is
  automatic.
- **Reset.** `CMD_RESET_PATH` (13) `[13][pubkey32]` sets `out_path_len = 0xFF`, so the next
  message floods and rediscovers. There is no push; the host already knows. The reply is OK,
  or ERR(2).
- **Manual path.** Write `out_path_len` and `out_path` with `CMD_ADD_UPDATE_CONTACT`.
- **Path of the last advert heard.** `CMD_GET_ADVERT_PATH` (42) `[42][0][pubkey32]` matches on
  the first 7 bytes against a 16-entry RAM table. It replies `RESP_CODE_ADVERT_PATH` (22)
  `[22][recv_ts u32][path_len][path bytes]`, or ERR(2) if the table has no entry.
- **Airtime.** Direct TX is priority 0. Flood priorities are: 1 for normal packets, 2 for
  PATH, 3 for advert.

## 3. Path discovery

`CMD_SEND_PATH_DISCOVERY_REQ` (52): `[52][0 reserved][pubkey 32]`. The minimum length is 34,
and byte 1 must be 0, or the reply is ERR(1).

- What it does: sends a telemetry request (`[tag][0x03][~0x01][0 0 0][rand4]`, base only),
  **always flood** (temporarily forcing `out_path_len = 0xFF`). The target answers inside a
  PATH packet.
- Reply: `RESP_CODE_SENT` with the tag (`pending_discovery = tag`).
- The target must actually answer the telemetry request:
  - A companion must allow BASE telemetry for us (telemetry.md, section 4).
  - A **repeater or room needs us in its ACL**, i.e. logged in.
  - Otherwise no response comes back.
- **`PUSH_CODE_PATH_DISCOVERY_RESPONSE` (0x8D)**:

  | Off | Size | Field |
  |---|---|---|
  | 0 | 1 | 0x8D |
  | 1 | 1 | reserved 0 |
  | 2 | 6 | target prefix6 |
  | 8 | 1 | `out_path_len` (encoded): path **from us to target**, carried inside the PATH payload |
  | 9 | n1 | out_path bytes, n1 = size * count |
  | 9+n1 | 1 | `in_path_len` (encoded): path the reply travelled **from target to us** (packet path) |
  | 10+n1 | n2 | in_path bytes |

- Surprise: in this case `MyMesh::onContactPathRecv` returns early. It **does not update the
  contact's stored out_path** and does not send a reciprocal path. If you want to use the
  discovered route, write it with `CMD_ADD_UPDATE_CONTACT`. The telemetry data in the
  response is discarded.

## 4. Trace

`CMD_SEND_TRACE_PATH` (36). The condition is `len > 10 && len - 10 < MAX_PACKET_PAYLOAD - 5`,
so 1..178 bytes of path.

| Off | Size | Field |
|---|---|---|
| 0 | 1 | 36 |
| 1 | 4 | tag u32 (choose a random value; it identifies the result) |
| 5 | 4 | auth_code u32 (carried, but not checked by repeater firmware in v1.17.1 core; use 0 or random) |
| 9 | 1 | flags: **bits 0-1 = path_sz, so hash bytes per hop = `1 << path_sz`** (1, 2, 4 or 8). Other bits are unused. |
| 10 | n | concatenated hop hashes (pubkey prefixes), n a multiple of `1<<path_sz`, `n >> path_sz <= 64` |

Note that the size encoding here is **different from `path_len`**: it is a power-of-two
exponent, not size-1. Trace flags have carried the hash size since v1.11; before that, every
hash was 1 byte and flags were 0. ERR(6) is returned if n is not a multiple or is too long.

- The reply is `RESP_CODE_SENT` `[6][0][tag][est_timeout_ms]`. The trace is always sent
  **direct**, and the hash list goes in the payload, not the packet path. The firmware does
  not record a pending trace.
- Propagation (`Mesh::onRecvPacket`). A node whose hash equals the entry at index
  `snr_count`, and which has forwarding enabled (`allowPacketForward`), appends **its receive
  SNR (int8, x4)** to the packet path and retransmits. So each hop records the SNR at which
  *it* heard the previous hop.
  - Companions do not forward: `allowPacketForward` returns false unless client-repeat is on.
  - To trace there and back, list the repeaters out and back, e.g. `[A, B, B, A]`, with
    `path_sz = 0`.
  - The trace packet hash includes `path_len`, so a node may appear more than once.
- Completion. When `snr_count << path_sz >= n`, **any node** that hears the packet calls
  `onTraceRecv`. On a companion this happens whenever the last listed hop transmits within
  radio range of us. The companion **does not filter by tag**, so every completed trace heard
  is pushed. Match `tag` yourself.
- **`PUSH_CODE_TRACE_DATA` (0x89)**:

  | Off | Size | Field |
  |---|---|---|
  | 0 | 1 | 0x89 |
  | 1 | 1 | reserved 0 |
  | 2 | 1 | `path_len` = **byte length of the hash list** (n), not a hop count |
  | 3 | 1 | flags (as sent) |
  | 4 | 4 | tag u32 |
  | 8 | 4 | auth_code u32 |
  | 12 | n | hop hashes |
  | 12+n | h | per-hop SNR, int8 x4, `h = n >> (flags&3)` entries; entry i = SNR at which hop i received |
  | 12+n+h | 1 | final SNR (int8 x4): SNR at which **this companion** heard the last hop |

  Total length is `13 + n + h`.

## 5. Binary requests (`CMD_SEND_BINARY_REQ`, 50)

`[50][pubkey 32][req_type][params...]`. The minimum length is 34. The contact must exist
(otherwise ERR(2)), and for repeaters, rooms and sensors **we must be logged in**.

- The companion prefixes `[tag u32 = RTC unique]` and sends `PAYLOAD_TYPE_REQ`, direct or
  flood depending on `out_path`. The request data can be up to 168 bytes
  (`MAX_PACKET_PAYLOAD - 16`).
- Reply: `RESP_CODE_SENT` `[6][flood][tag][est_timeout_ms]`.
- Answer: **`PUSH_CODE_BINARY_RESPONSE` (0x8C)** `[0x8C][0][tag u32][response body]`, matched
  on `tag == pending_req`. Only one request can be pending; see companion-protocol.md,
  section 8.
- The request types are listed in repeaters-and-rooms.md, section 8. Two of them are detailed
  below.

### 5.1 Neighbours (`REQ_TYPE_GET_NEIGHBOURS` = 0x06, repeater)

Request params (`simple_repeater/MyMesh.cpp handleRequest`):

| Off (after req_type) | Size | Field |
|---|---|---|
| 0 | 1 | request_version = 0 (any other value gets no reply) |
| 1 | 1 | count: maximum entries wanted |
| 2 | 2 | offset u16 LE into the sorted list |
| 4 | 1 | order_by: 0 = newest heard first, 1 = oldest first, 2 = strongest SNR first, 3 = weakest first |
| 5 | 1 | pubkey_prefix_length (clamped to 32) |
| 6 | 4 | random bytes (packet-hash uniqueness) |

So the full command is `[50][pubkey32][0x06][0][count][off_lo][off_hi][order][plen][r r r r]`.

Response body, i.e. the bytes after the tag in the 0x8C push:

| Off | Size | Field |
|---|---|---|
| 0 | 2 | total neighbours known, i16 LE |
| 2 | 2 | entries in this reply, u16 LE |
| 4 | k*(plen+5) | entries: `[pubkey prefix (plen)][heard_secs_ago u32 LE][snr int8 x4]` |

- Entries are limited to a 130-byte buffer, so at most `floor(130/(plen+5))` per reply. For
  example, that is 11 entries with plen = 6, or 14 with plen = 4. Page through the list with
  `offset`.
- The neighbour table holds `MAX_NEIGHBOURS` entries (50 in the common variant build flags;
  0 compiles the feature out, giving an always-empty reply). It contains only repeaters heard
  via **zero-hop adverts** (not "shared" adverts), or replies to `discover.neighbors`.
- SNR is the advert's receive SNR at the repeater. There is no permission check, so any ACL
  member, including a guest, may ask.

### 5.2 Owner info (`0x07`, repeater FIRMWARE_VER_LEVEL >= 2)

Request `[50][pubkey32][0x07]`. The response body is ASCII
`"<fw version>\n<node name>\n<owner_info>"`.

## 6. Node discovery (control packets, 1.10+)

`CMD_SEND_CONTROL_DATA` (55) sends `[55][ctl bytes...]` **zero-hop**. The first ctl byte must
have bit 7 set, otherwise ERR(1). Repeaters answer `CTL_TYPE_NODE_DISCOVER_REQ`:

| Request byte | Field |
|---|---|
| 0 | `0x80 \| prefix_only` (bit0: reply with an 8-byte key prefix instead of the full key) |
| 1 | type filter bitmask, `1 << adv_type`. Repeaters respond if `0x04` (`1<<2`) is set |
| 2 | tag u32 |
| 6 | [since u32] optional: only nodes whose regions changed at or after `since` reply |

Repeaters that have repeating enabled reply after a random delay, limited to 4 per 2 minutes.
The reply arrives as **`PUSH_CODE_CONTROL_DATA` (0x8E)**:

```
[0x8E][snr4 of reply][rssi][path_len (0)][0x90|node_type][snr4 of our request at the repeater][tag u32][pubkey 32 or 8]
```

## 7. Raw sends

- `CMD_SEND_RAW_DATA` (25): `[25][path_len][path][payload >= 4]`. This sends
  `PAYLOAD_TYPE_RAW_CUSTOM` direct. In **1.17.1, `path_len` is a plain byte count** (int8,
  0..127; flood is not supported, so 0 means zero-hop). 1.18 switched to the encoded form.
  Received RAW_CUSTOM packets arrive as `PUSH_RAW_DATA` (0x84):
  `[0x84][snr4][rssi][0xFF][payload]`.
- `CMD_SEND_RAW_PACKET` (65, 1.16+): `[65][priority u8][full packet bytes]`, where the packet
  bytes are in `Packet::writeTo` format. It is parsed by `tryParsePacket` and queued as-is.
  The reply is ERR(6) if parsing fails.
- `CMD_SEND_CHANNEL_DATA` (62, 1.15+): `[62][ch_idx][path_len (0xFF = flood)][path][data_type u16 LE][data]`.
  `data_type` 0 is rejected; 0xFF00-0xFFFF is the dev range. The data limit is set by two
  checks:
  - The companion check allows up to 167 bytes (`MAX_FRAME_SIZE - 9`).
  - `sendGroupData` then rejects anything over `MAX_GROUP_DATA_LENGTH` = 184-16-3 = **165**,
    and that failure is reported as ERR(3).

  So the effective maximum is 165 bytes. Received group datagrams arrive as queued
  `RESP_CODE_CHANNEL_DATA_RECV` (27) frames.
- `PUSH_LOG_RX_DATA` (0x88) `[0x88][snr4][rssi][raw packet]` is emitted for **every** packet
  received, so the host can implement its own sniffing and decoding.
