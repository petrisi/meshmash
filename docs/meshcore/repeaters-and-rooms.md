# Repeaters and room servers: login, status, ACL, room sync

This document covers how a companion talks to repeaters and room servers: logging in, asking
for status, the access control list (ACL), and how room posts are synced.

Sources, all at tag `companion-v1.17.1`:

- `examples/companion_radio/MyMesh.cpp` (companion side)
- `src/helpers/BaseChatMesh.cpp` (`sendLogin`, `sendRequest`, connection table)
- `examples/simple_repeater/MyMesh.cpp` (`handleLoginReq`, `handleRequest`, `onAnonDataRecv`,
  `onPeerDataRecv`)
- `examples/simple_room_server/MyMesh.cpp`
- `src/helpers/ClientACL.{h,cpp}`
- `examples/simple_sensor/SensorMesh.cpp`

Repeater and room firmware at the same tag report `v1.17.1`. Integers are little-endian.

## 1. Over-the-air model (what the companion sends)

- **Login** is a `PAYLOAD_TYPE_ANON_REQ` (7). The payload is
  `[dest_hash 1][sender pubkey 32][MAC 2][AES-128-ECB ciphertext]`. The key is the ECDH shared
  secret between the two identities, so the server can decrypt a login from a stranger.
- **Requests** (status, telemetry, binary) are `PAYLOAD_TYPE_REQ` (0). They use only 1-byte
  dest/src hashes. The server can decrypt one **only if the sender is already in its ACL**,
  which is the only place it keeps shared secrets (`searchPeersByHash` scans `acl`). So a
  status, telemetry or neighbours request to a repeater or room **requires a prior successful
  login**, even as a guest. Otherwise the request is silently ignored.
- **Responses** are `PAYLOAD_TYPE_RESPONSE` (1). If the request arrived by flood, the response
  is wrapped in a `PAYLOAD_TYPE_PATH` return (with `extra_type = RESPONSE`). That also teaches
  the companion the direct path, and the companion then emits `PUSH_CODE_PATH_UPDATED` (0x81).
  The plaintext of every response starts with a 4-byte tag or timestamp.

## 2. Login

### 2.1 Command

`CMD_SEND_LOGIN` (26): `[26][pubkey 32][password bytes...]`. The minimum length is 33, and
the password is not NUL-terminated in the frame.

- The contact must exist in the companion's contact table. If it does not, the reply is
  `ERR(2)`.
- Only the first **15** password bytes are used (`BaseChatMesh::sendLogin`).
- The plaintext the companion builds depends on the **contact type stored on the companion**:

  | Contact type | Plaintext (before AES) |
  |---|---|
  | `ADV_TYPE_ROOM` (3) | `[now u32 (RTC, unique)][contact.sync_since u32][password <=15]` |
  | anything else | `[now u32][password <=15]` |

  If a room server is stored with the wrong type, the server reads the password starting at
  the wrong offset, so the login fails.
- Routing: if `contact.out_path_len == 0xFF` the request is sent flood (scoped by the
  companion's flood scope), otherwise direct.
- Reply: `RESP_CODE_SENT` `[6][flood u8][tag u32][est_timeout_ms u32]`. For logins the tag is
  **the first 4 bytes of the target's public key**, not a timestamp, because
  `pending_login = memcpy(pubkey,4)`.

### 2.2 What the server does (repeater, `handleLoginReq`)

The repeater decrypts the request and decides as follows.

- If the 5th plaintext byte is 0 or at least `' '` (0x20), the request is a password login.
  The values 0x01..0x03 select other anonymous request types (section 7).
- **Empty password** (`data[0] == 0`): if the sender is already in the ACL, login succeeds
  with its stored permissions and no password is checked. Otherwise the server falls through
  to the normal compare.
- Password compare, in order:
  1. If it equals `password` (admin), the role is `PERM_ACL_ADMIN` (3).
  2. Otherwise, if it equals `guest_password`, the role is `PERM_ACL_GUEST` (0).
  3. Otherwise **the server sends no reply at all**, so the client just times out.
- `guest_password` defaults to **empty** on a repeater. So by default an empty-password login
  from anyone succeeds as a guest. If the admin password were empty, an empty password would
  log in as admin; the default admin password is `"password"` unless changed.
- Replay check: `sender_timestamp` must be greater than the client's `last_timestamp`, or the
  server does not reply.
- The client is stored in the ACL (`acl.putClient`, max `MAX_CLIENTS`, 20 by default in
  `ClientACL.h`). When the ACL is full, the least-recently-active **non-admin** entry is
  evicted. Guest entries (permissions 0) are **never saved to flash**, so they are lost on
  reboot. Admin entries are saved to `/s_contacts`.
- If the login arrived by flood, the stored `out_path` is reset, and the response returns via
  a PATH flood.
- **Room server** (`simple_room_server onAnonDataRecv`): the password starts at plaintext
  offset 8. The roles are:
  - admin password: ADMIN (3)
  - `guest_password` (the "room password", set at build time with `ROOM_PASSWORD`; common
    variants use `"hello"`): `PERM_ACL_READ_WRITE` (2)
  - anything else: GUEST (0) if `allow.read.only` is on, otherwise no reply

  The room also stores `sync_since` from the login. It saves only admins to flash.
- **Sensor** (`SensorMesh::handleLoginReq`): admin password only, or an empty password if the
  sender is already in the ACL. Anything else gets no reply.

### 2.3 Server response plaintext (13 bytes)

| Off | Size | Field |
|---|---|---|
| 0 | 4 | server `now` u32 (server RTC, unique) |
| 4 | 1 | `RESP_SERVER_LOGIN_OK` = 0 |
| 5 | 1 | legacy keep-alive interval / 16. **Always 0 in v1.17.1.** |
| 6 | 1 | legacy "is_admin". Repeater/sensor: 1 admin, else 0. Room: 1 admin, 2 if permissions == 0 (read-only guest), else 0 |
| 7 | 1 | full ACL permissions byte (low 2 bits = role, see section 6) |
| 8 | 4 | random bytes (packet-hash uniqueness) |
| 12 | 1 | `FIRMWARE_VER_LEVEL`: repeater 2, room 1, sensor 1 |

Very old servers replied with `"OK"` at offset 4 (the legacy form).

### 2.4 Push to host

The companion matches the response in `MyMesh::onContactResponse` against `pending_login`
(the first 4 bytes of the pubkey) and emits one of the following.

**`PUSH_CODE_LOGIN_SUCCESS` (0x85)** for a new-style response:

| Off | Size | Field |
|---|---|---|
| 0 | 1 | 0x85 |
| 1 | 1 | legacy is_admin byte (response[6]) |
| 2 | 6 | server pubkey prefix6 |
| 8 | 4 | server timestamp u32 (response[0..3]); usable as the server clock |
| 12 | 1 | ACL permissions (response[7]) (v7+) |
| 13 | 1 | server `FIRMWARE_VER_LEVEL` (response[12]) |

The total is 14 bytes. For a legacy `"OK"` response the push is 8 bytes:
`[0x85][0][prefix6]`.

**`PUSH_CODE_LOGIN_FAIL` (0x86)**: `[0x86][0][prefix6]`. It is sent only when a matching
response arrives that is neither `"OK"` nor code 0. **A wrong password produces no push at
all** because the server stays silent. Treat a timeout (`est_timeout_ms` plus margin) as
"failed or unreachable".

### 2.5 How long a login lasts / keep-alive

- If `response[5]` is greater than 0, the companion calls `startConnection(contact,
  response[5]*16 secs)`. Current servers always send 0, so **no connection entry is created**.
  Even if one were, `checkConnections()` (which would send `REQ_TYPE_KEEP_ALIVE`) is commented
  out in v1.17.1 `MyMesh::checkSerialInterface`. As a result:
  - `CMD_HAS_CONNECTION` (28) returns `ERR(2)` after a modern login.
  - `CMD_LOGOUT` (29) only clears the local connection table entry. It sends **nothing over
    the air**, so the server keeps the client in its ACL.
- Server side, a login has **no time-based expiry** (`// TODO: periodically check for
  OLD/inactive entries` in the room `loop()`). It lasts until one of these happens:
  - the client is evicted because the ACL is full (non-admins only),
  - the server reboots (guests are not persisted; admins are, with their shared secret, so an
    admin's requests keep working after a server reboot without logging in again), or
  - `setperm <pubkey> 0` removes it.
- Re-logging in is cheap. The usual pattern is to log in once per session before requests.
  An empty-password login also works for ACL members, without resending the password.

## 3. Status request

`CMD_SEND_STATUS_REQ` (27): `[27][pubkey 32]`. This sends `PAYLOAD_TYPE_REQ` with the
13-byte plaintext built by `sendRequest(contact, REQ_TYPE_GET_STATUS, ...)`:

```
[tag u32 = RTC unique][0x01][0 0 0 0][random 4]
```

The reply is `RESP_CODE_SENT` with `tag` set to that timestamp. However, the response is
matched on the pubkey prefix (`pending_status`, legacy scheme), not on the tag.

The server replies with `[tag u32 (echo)][stats struct]`. Guests may request status on
repeaters and rooms.

**`PUSH_CODE_STATUS_RESPONSE` (0x87)**: `[0x87][0][prefix6][stats struct...]`. The struct
starts at frame offset 8, and its exact length depends on the server type.

### 3.1 Repeater `RepeaterStats` (56 bytes, `simple_repeater/MyMesh.h`)

| Off (in struct) | Type | Field |
|---|---|---|
| 0 | u16 | batt_milli_volts |
| 2 | u16 | curr_tx_queue_len |
| 4 | i16 | noise_floor (dBm) |
| 6 | i16 | last_rssi (dBm) |
| 8 | u32 | n_packets_recv |
| 12 | u32 | n_packets_sent |
| 16 | u32 | total_air_time_secs (TX) |
| 20 | u32 | total_up_time_secs |
| 24 | u32 | n_sent_flood |
| 28 | u32 | n_sent_direct |
| 32 | u32 | n_recv_flood |
| 36 | u32 | n_recv_direct |
| 40 | u16 | err_events (`_err_flags` bitmask) |
| 42 | i16 | last_snr x 4 |
| 44 | u16 | n_direct_dups |
| 46 | u16 | n_flood_dups |
| 48 | u32 | total_rx_air_time_secs |
| 52 | u32 | n_recv_errors |

The struct has no padding, because every field is naturally aligned. Older repeaters send a
shorter struct, so decode by length: at least 48 bytes is the base set, and offsets 48 and 52
are newer fields.

### 3.2 Room server `ServerStats` (52 bytes)

Offsets 0..47 match the repeater struct. After that:

| Off | Type | Field |
|---|---|---|
| 48 | u16 | n_posted (posts stored since boot) |
| 50 | u16 | n_post_push (push attempts since boot) |

The two structs **differ after byte 47**, so pick the decoder by contact type: 2 = repeater,
3 = room.

### 3.3 Sensor

`simple_sensor` defines `REQ_TYPE_GET_STATUS` but `handleRequest` has no case for it, so no
reply is sent (v1.17.1).

## 4. Room server message sync

- A post is made by sending a normal DM: `CMD_SEND_TXT_MSG` with `TXT_TYPE_PLAIN`. The room
  ACKs it, so `PUSH_SEND_CONFIRMED` arrives, and stores it unless the sender's role is GUEST
  (0). Posts are capped at 151 chars (`MAX_POST_TEXT_LEN = 160-9`).
- Storage is a RAM ring of `MAX_UNSYNCED_POSTS` (32) posts. They are **not persisted**, so
  they are lost on reboot. `post_timestamp` is the **room's** clock.
- At login the client sends `sync_since`. The companion sends `contact.sync_since`, which it
  advances itself (see below). The room then pushes posts with
  `post_timestamp > sync_since`, skipping posts the client authored itself, one at a time and
  round-robin across clients:
  - The interval is `SYNC_PUSH_INTERVAL` 1200 ms after a push, 150 ms otherwise.
  - Posts younger than 6 s are held back (`POST_SYNC_DELAY_SECS`).
  - Each push waits for an ACK: 12 s timeout if sent flood, or
    `4000 + 2000*(hops+1)` ms if sent direct. After **3 consecutive ACK failures** the room
    stops pushing to that client until the client sends any message or request, which resets
    `push_failures`.
  - On ACK, the room advances that client's `sync_since` to the post's timestamp.
  - Clients loaded from flash after a room reboot have `last_activity == 0`, so they get no
    pushes until they interact.
- Push wire format: a `PAYLOAD_TYPE_TXT_MSG` whose plaintext is
  `[post_ts u32][(2<<2)|attempt][author pubkey prefix 4][text]`, i.e. `TXT_TYPE_SIGNED_PLAIN`.
- The companion (`BaseChatMesh::onPeerDataRecv`) handles the push as follows:
  1. It sets `contact.sync_since = max(sync_since, post_ts)`. This value is persisted lazily
     and sent in the next login.
  2. It ACKs with `sha256(plaintext[0 .. 9+textlen) || OWN pubkey)[0..4]`.
  3. It queues `RESP_CONTACT_MSG_RECV_V3` with `txt_type = 2`, `extra` = the 4-byte author
     prefix, followed by the text. `ts` is the room's post time.
- System posts (`room.post <text>`, an admin CLI command) have the room's own key as author.
- There is no host command to set `sync_since` directly. `CMD_ADD_UPDATE_CONTACT` does not
  carry it, and a newly added contact starts at 0, which means the full backlog of up to 32
  posts. To "resync everything", remove and re-add the contact (unverified that official apps
  do this).
- `REQ_TYPE_KEEP_ALIVE` (0x02) exists on rooms. It is accepted only when routed direct, and
  it carries `[0x02][force_since u32]` and is answered with an **ACK** packet carrying one
  extra byte, the unsynced count. The v1.17.1 companion never sends it. If you send it via
  `CMD_SEND_BINARY_REQ`, the ACK answer is not surfaced to the host, because only DM ACKs in
  the expected-ack table are reported.

## 5. ACL request (admin only)

This is sent as `CMD_SEND_BINARY_REQ` (50): `[50][pubkey 32][0x05][0][0]`. Bytes 1-2 are
reserved and must be 0, or the server sends no reply. You may append random bytes for
packet-hash uniqueness.

The answer is `PUSH_CODE_BINARY_RESPONSE` `[0x8C][0][tag u32][entries...]`, where each entry
is 7 bytes: `[pubkey prefix6][permissions u8]`. The firmware stops adding entries once
`ofs + 7 > 180` (so at most 25 entries).

- Repeater: lists all entries with permissions != 0.
- Room: lists **admins only**.
- Sensor: lists permissions != 0.
- Non-admin requesters get no reply.

ACL entries are modified only through the CLI command `setperm <pubkey-hex> <perm>`. See
cli-over-lora.md.

## 6. Permission byte

| Bits | Meaning |
|---|---|
| 0-1 | role: 0 GUEST, 1 READ_ONLY, 2 READ_WRITE, 3 ADMIN (`PERM_ACL_ROLE_MASK = 3`) |
| 2-5 | unused by repeater/room in v1.17.1 |
| 6 | sensor: `PERM_RECV_ALERTS_LO` |
| 7 | sensor: `PERM_RECV_ALERTS_HI` |

Capabilities by role:

- Only ADMIN may run CLI commands. On a room, a non-admin CLI attempt gets no ACK and no
  reply.
- Only ADMIN may read the ACL.
- On a room, GUEST may not post. READ_ONLY (1) is only reachable via `setperm`, and the v1.17.1
  room code does not actually block it from posting (observation from source).
- Any ACL member may request status, telemetry and neighbours. For telemetry, a GUEST gets
  base data only (section 7 of telemetry.md).
- `setperm` with role 0 **removes** the entry, because guests are not stored. Any other role
  requires the full 64-hex-character public key.

## 7. Anonymous requests (no login needed)

`CMD_SEND_ANON_REQ` (57), from 1.12: `[57][pubkey 32][data...]`. The plaintext on air is
`[tag u32][data...]`. Since FIRMWARE_VER_CODE 13, the target does not have to be a contact.
The companion creates a transient entry with type 0 and **out_path_len = 0, i.e. zero-hop
direct**, which is never saved.

The companion matches the response by tag into `PUSH_CODE_BINARY_RESPONSE`
`[0x8C][0][tag][rest]`.

Repeater types. These require the request to arrive **direct**. They are rate-limited to
4 per 3 minutes in total (`anon_limiter`). `data[0]` is the type, followed by
`reply_path_len` and the reply path, encoded as in paths-and-trace.md. Use 0 for a zero-hop
reply.

| data[0] | Name | Response (after tag) |
|---|---|---|
| 0x01 | ANON_REQ_TYPE_REGIONS | `[server_now u32][names]`. The names are flood-allowed regions as comma-separated ASCII with the leading `#` stripped; `*` means the wildcard is allowed (`RegionMap::exportNamesTo`) |
| 0x02 | ANON_REQ_TYPE_OWNER | `[server_now u32]["<name>\n<owner_info>"]` |
| 0x03 | ANON_REQ_TYPE_BASIC | `[server_now u32][features u8]`: bit0 is a bridge (0x01 = RS232, 0x03 = ESP-NOW); 0x80 means repeating is disabled |

If `data[0]` is 0 or at least 0x20, the request is a password login (section 2). The
response then arrives as a BINARY_RESPONSE carrying the raw 13-byte login reply minus the tag.

## 8. Logged-in binary requests (summary)

The plaintext is `[tag u32][req_type][params...]`. The companion builds it from
`CMD_SEND_BINARY_REQ` `[50][pubkey32][req_type][params...]` by prefixing the tag.

| req_type | Name | Who | Params | Response body (after tag) |
|---|---|---|---|---|
| 0x01 | GET_STATUS | rep/room | 4 reserved | stats struct (section 3) |
| 0x02 | KEEP_ALIVE | room | since u32 (direct only) | ACK packet, not RESPONSE |
| 0x03 | GET_TELEMETRY_DATA | all | inverse perm mask u8, 3 reserved | CayenneLPP (telemetry.md) |
| 0x04 | GET_AVG_MIN_MAX | sensor (role >= READ_ONLY) | start_secs_ago u32, end_secs_ago u32, 0, 0 | see telemetry.md |
| 0x05 | GET_ACCESS_LIST | admin | 0, 0 | section 5 |
| 0x06 | GET_NEIGHBOURS | repeater | see paths-and-trace.md | see paths-and-trace.md |
| 0x07 | GET_OWNER_INFO | repeater (FIRMWARE_VER_LEVEL >= 2) | - | `"<fw ver>\n<name>\n<owner_info>"` |

Unknown types, or types the requester lacks permission for, get **no reply**.
