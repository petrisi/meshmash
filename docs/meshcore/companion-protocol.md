# MeshCore companion protocol

Reference for the host-to-companion-radio protocol, written so it can be implemented
byte for byte. Unless a section says otherwise, everything here comes from reading the
firmware source at tag **`companion-v1.17.1`** (`FIRMWARE_VER_CODE 13`) of
`meshcore-dev/MeshCore`. The main file is `examples/companion_radio/MyMesh.cpp`
(`MyMesh::handleCmdFrame`); helpers come from `src/helpers/BaseChatMesh.cpp`, `src/Mesh.cpp`
and `src/Packet.cpp`. Where the source and `docs/companion_protocol.md` disagree, the source wins.

Related documents: [repeaters-and-rooms.md](repeaters-and-rooms.md),
[telemetry.md](telemetry.md), [cli-over-lora.md](cli-over-lora.md),
[paths-and-trace.md](paths-and-trace.md), [config.md](config.md).

Conventions used in all of these documents:

- Multi-byte integers are **little-endian** (`memcpy` of native ARM/ESP32 values). The one
  exception is CayenneLPP telemetry, which is big-endian (see telemetry.md).
- `prefix6` means the first 6 bytes of a 32-byte Ed25519 public key.
- `snr4` is an `int8` holding SNR x 4. Divide by 4 to get dB.
- Offsets count from the first byte of the frame payload, which is the code byte.

## 1. Framing (USB serial)

The framing comes from `src/helpers/ArduinoSerialInterface.cpp`. The link runs at 115200 baud.

| Direction | Bytes |
|---|---|
| host -> radio | `'<'` (0x3C), `len` u16 LE, `payload[len]` |
| radio -> host | `'>'` (0x3E), `len` u16 LE, `payload[len]` |

- `MAX_FRAME_SIZE = 176` (`src/helpers/BaseSerialInterface.h`).
- If an outbound frame is larger than 176 bytes, `writeFrame` **silently drops** it and returns 0.
  The firmware tries to avoid this, for example by clamping text and limiting the LPP buffer.
- On inbound frames, bytes past 176 are discarded and the frame is truncated to 176.
- An inbound frame with length 0 is ignored. The receive state machine resyncs on the next `'<'`.
- No checksum is used. A USB serial interface reports `isConnected()` as always true, so push
  frames are always written. On BLE they are written only while a client is connected.
- The firmware handles one command at a time, synchronously. Each command gets one reply
  frame (or a stream of them, for `CMD_GET_CONTACTS`). Push frames (0x80 and up) can arrive
  between any two frames. During contact iteration, `RESP_CODE_CONTACT` frames are produced
  from `loop()` between commands.

## 2. Session start and versioning

1. `CMD_DEVICE_QUERY` = `[22][app_target_ver u8]`. The firmware stores `app_target_ver` and
   uses it for one thing only: if it is 3 or higher, received messages are delivered as
   `*_MSG_RECV_V3` frames, which carry SNR. Send 3.
   The reply is `RESP_CODE_DEVICE_INFO`:

   | Off | Size | Type | Field |
   |---|---|---|---|
   | 0 | 1 | u8 | 13 (`RESP_CODE_DEVICE_INFO`) |
   | 1 | 1 | u8 | `FIRMWARE_VER_CODE` (13 in v1.17.x) |
   | 2 | 1 | u8 | `MAX_CONTACTS / 2` (v3+) |
   | 3 | 1 | u8 | `MAX_GROUP_CHANNELS` (v3+) |
   | 4 | 4 | u32 | `ble_pin` as stored in prefs (0 means default/none) |
   | 8 | 12 | char[12] | build date, NUL-padded, e.g. `"14 Aug 2026"` |
   | 20 | 40 | char[40] | manufacturer/board name, NUL-padded |
   | 60 | 20 | char[20] | firmware version string, e.g. `"v1.17.1"` |
   | 80 | 1 | u8 | client repeat enabled, 0/1 (v9+) |
   | 81 | 1 | u8 | `path_hash_mode`, 0..2 (v10+) |

2. `CMD_APP_START` = `[1][7 reserved bytes][app_name UTF-8...]`. The minimum length is 8.
   This command also stops any contact iteration that was left running. The reply is
   `RESP_CODE_SELF_INFO`:

   | Off | Size | Type | Field |
   |---|---|---|---|
   | 0 | 1 | u8 | 5 |
   | 1 | 1 | u8 | adv type (always 1 = CHAT) |
   | 2 | 1 | **i8** | tx power in dBm (can be negative, down to -9) |
   | 3 | 1 | u8 | `MAX_LORA_TX_POWER` |
   | 4 | 32 | bytes | self public key |
   | 36 | 4 | i32 | lat x 1e6 |
   | 40 | 4 | i32 | lon x 1e6 |
   | 44 | 1 | u8 | `multi_acks` |
   | 45 | 1 | u8 | `advert_loc_policy` (0 = none, 1 = share) |
   | 46 | 1 | u8 | telemetry modes: `env<<4 \| loc<<2 \| base` (2 bits each) |
   | 47 | 1 | u8 | `manual_add_contacts` |
   | 48 | 4 | u32 | freq in kHz (`freq_MHz*1000`) |
   | 52 | 4 | u32 | bw in Hz (`bw_kHz*1000`) |
   | 56 | 1 | u8 | sf |
   | 57 | 1 | u8 | cr |
   | 58 | n | utf8 | node name (no NUL; runs to end of frame) |

`FIRMWARE_VER_CODE` by release. These values were fetched from each tag's `MyMesh.h`:

| fw | 1.7.0 | 1.7.4-1.9.0 | 1.10-1.12 | 1.13 | 1.14.x | 1.15 | 1.16-1.17.1 | 1.18.0 |
|---|---|---|---|---|---|---|---|---|
| ver code | 5 | 7 | 8 | 9 | 10 | 11 | 13 | 14 |

## 3. Command codes (host -> radio)

The "since" column gives the first sampled `companion-vX` tag whose source defines the code.
The sampled tags were 1.4.0, 1.5.0, 1.6.0, 1.7.0, 1.7.4, 1.8.0, 1.9.0, 1.10.0 through 1.18.0,
so a code may actually be up to one sampled tag older than shown. "<=1.4" means it already
existed at 1.4.0.

| Code | Name | Since | Request payload (after code byte) | Reply |
|---|---|---|---|---|
| 1 | APP_START | <=1.4 | 7 reserved, app name | SELF_INFO |
| 2 | SEND_TXT_MSG | <=1.4 | txt_type u8, attempt u8, ts u32, prefix6, text | SENT / ERR |
| 3 | SEND_CHANNEL_TXT_MSG | <=1.4 | txt_type u8 (must be 0), ch_idx u8, ts u32, text | OK / ERR |
| 4 | GET_CONTACTS | <=1.4 | [since u32] optional | CONTACTS_START, CONTACT*, END_OF_CONTACTS |
| 5 | GET_DEVICE_TIME | <=1.4 | - | CURR_TIME |
| 6 | SET_DEVICE_TIME | <=1.4 | secs u32 | OK, or ERR(6) if `secs` < current time |
| 7 | SEND_SELF_ADVERT | <=1.4 | [1 = flood, else zero-hop] optional | OK |
| 8 | SET_ADVERT_NAME | <=1.4 | name bytes (max 31) | OK |
| 9 | ADD_UPDATE_CONTACT | <=1.4 | contact record (see section 6) | OK / ERR(3) |
| 10 | SYNC_NEXT_MESSAGE | <=1.4 | - | queued msg frame, or NO_MORE_MESSAGES |
| 11 | SET_RADIO_PARAMS | <=1.4 | freq_kHz u32, bw_Hz u32, sf, cr, [repeat u8] | OK / ERR(6) |
| 12 | SET_RADIO_TX_POWER | <=1.4 | dBm i8 | OK / ERR(6) |
| 13 | RESET_PATH | <=1.4 | pubkey32 | OK / ERR(2) |
| 14 | SET_ADVERT_LATLON | <=1.4 | lat i32, lon i32, [alt i32, ignored] | OK / ERR(6) |
| 15 | REMOVE_CONTACT | <=1.4 | pubkey32 | OK / ERR(2) |
| 16 | SHARE_CONTACT | <=1.4 | pubkey32 | OK / ERR |
| 17 | EXPORT_CONTACT | <=1.4 | [pubkey32]; no key means self | EXPORT_CONTACT |
| 18 | IMPORT_CONTACT | <=1.4 | raw advert packet (len > 98) | OK / ERR(6) |
| 19 | REBOOT | <=1.4 | ASCII `"reboot"` | (reboots, no reply) |
| 20 | GET_BATT_AND_STORAGE | <=1.4 (renamed 1.7.4) | - | BATT_AND_STORAGE |
| 21 | SET_TUNING_PARAMS | <=1.4 | rx_delay x1000 u32, airtime_factor x1000 u32 | OK |
| 22 | DEVICE_QUERY | <=1.4 | app_target_ver u8 | DEVICE_INFO |
| 23 | EXPORT_PRIVATE_KEY | <=1.4 | - | PRIVATE_KEY(64) or DISABLED |
| 24 | IMPORT_PRIVATE_KEY | <=1.4 | 64-byte private key | OK / ERR / DISABLED |
| 25 | SEND_RAW_DATA | <=1.4 | path_len, path, payload (>= 4 bytes) | OK / ERR |
| 26 | SEND_LOGIN | <=1.4 | pubkey32, password (<= 15 used) | SENT / ERR |
| 27 | SEND_STATUS_REQ | <=1.4 | pubkey32 | SENT / ERR |
| 28 | HAS_CONNECTION | <=1.4 | pubkey32 | OK / ERR(2) |
| 29 | LOGOUT | <=1.4 | pubkey32 | OK (local only) |
| 30 | GET_CONTACT_BY_KEY | <=1.4 | pubkey32 | CONTACT / ERR(2) |
| 31 | GET_CHANNEL | <=1.4 | idx u8 | CHANNEL_INFO / ERR(2) |
| 32 | SET_CHANNEL | <=1.4 | idx u8, name[32], secret[16] | OK / ERR |
| 33 | SIGN_START | <=1.4 | - | SIGN_START |
| 34 | SIGN_DATA | <=1.4 | data chunk | OK / ERR |
| 35 | SIGN_FINISH | <=1.4 | - | SIGNATURE(64) |
| 36 | SEND_TRACE_PATH | <=1.4 | tag u32, auth u32, flags u8, path hashes | SENT / ERR |
| 37 | SET_DEVICE_PIN | <=1.4 | pin u32 | OK / ERR(6) |
| 38 | SET_OTHER_PARAMS | 1.5.0 | manual_add, [telem modes], [adv_loc], [multi_acks] | OK |
| 39 | SEND_TELEMETRY_REQ | 1.6.0 | 3 reserved, [pubkey32] | SENT, or TELEMETRY push (self) |
| 40 | GET_CUSTOM_VARS | 1.6.0 | - | CUSTOM_VARS |
| 41 | SET_CUSTOM_VAR | 1.6.0 | `"name:value"` ASCII | OK / ERR(6) |
| 42 | GET_ADVERT_PATH | 1.7.4 | reserved u8, pubkey32 | ADVERT_PATH / ERR(2) |
| 43 | GET_TUNING_PARAMS | 1.7.4 | - | TUNING_PARAMS |
| 44-49 | (parked for WiFi) | | | |
| 50 | SEND_BINARY_REQ | 1.7.4 | pubkey32, req bytes | SENT / ERR |
| 51 | FACTORY_RESET | 1.7.4 | ASCII `"reset"` | OK, then reboot |
| 52 | SEND_PATH_DISCOVERY_REQ | 1.8.0 | reserved u8 (=0), pubkey32 | SENT / ERR |
| 53 | (unused) | | | |
| 54 | SET_FLOOD_SCOPE_KEY | 1.10.0 (was SET_FLOOD_SCOPE) | 0, [key16], or 1 (v12+) | OK |
| 55 | SEND_CONTROL_DATA | 1.10.0 | ctl bytes (first byte & 0x80 != 0) | OK / ERR |
| 56 | GET_STATS | 1.11.0 | stats type u8 | STATS / ERR(6) |
| 57 | SEND_ANON_REQ | 1.12.0 | pubkey32, data | SENT / ERR |
| 58 | SET_AUTOADD_CONFIG | 1.12.0 | bitmask u8, [max_hops u8] | OK |
| 59 | GET_AUTOADD_CONFIG | 1.12.0 | - | AUTOADD_CONFIG |
| 60 | GET_ALLOWED_REPEAT_FREQ | 1.13.0 | - | ALLOWED_REPEAT_FREQ |
| 61 | SET_PATH_HASH_MODE | 1.14.0 | 0, mode u8 (0..2) | OK / ERR(6) |
| 62 | SEND_CHANNEL_DATA | 1.15.0 | ch_idx, path_len, [path], data_type u16, data | OK / ERR |
| 63 | SET_DEFAULT_FLOOD_SCOPE | 1.15.0 | [name[31], key16] | OK / ERR(6) |
| 64 | GET_DEFAULT_FLOOD_SCOPE | 1.15.0 | - | DEFAULT_FLOOD_SCOPE |
| 65 | SEND_RAW_PACKET | 1.16.0 | priority u8, raw packet | OK / ERR |
| 66 | RUN_CLI_COMMAND | **1.18.0** | CLI text | CLI_REPLY (29) |

`SHARE_CONTACT` (16) re-sends the contact's last advert as stored by the radio, unchanged and
zero-hop (`BaseChatMesh::shareContactZeroHop`). Works for any contact type. ERR(2): no such
contact. ERR(3): no stored advert (e.g. a contact added with ADD_UPDATE_CONTACT or from a link
and never heard) or no free packet.

Any other code gets `[1][1]` (`ERR_CODE_UNSUPPORTED_CMD`). A command that is shorter than
its length check also falls through to this generic error. For example, `CMD_SEND_LOGIN`
shorter than 33 bytes returns ERR(1), not ERR(6).

## 4. Response codes (radio -> host, solicited)

| Code | Name | Layout (after code) |
|---|---|---|
| 0 | OK | - |
| 1 | ERR | err_code u8 |
| 2 | CONTACTS_START | total count u32 (unfiltered, excludes anon slots) |
| 3 | CONTACT | contact record (section 6) |
| 4 | END_OF_CONTACTS | most_recent_lastmod u32 (use as next `since`) |
| 5 | SELF_INFO | section 2 |
| 6 | SENT | flood u8 (1 = sent flood, 0 = direct), tag/expected_ack u32, est_timeout_ms u32 |
| 7 | CONTACT_MSG_RECV | prefix6, path_len, txt_type, ts u32, [extra], text (only when app ver < 3) |
| 8 | CHANNEL_MSG_RECV | ch_idx, path_len, txt_type, ts u32, text (only when app ver < 3) |
| 9 | CURR_TIME | epoch secs u32 |
| 10 | NO_MORE_MESSAGES | - |
| 11 | EXPORT_CONTACT | raw advert packet bytes (`Packet::writeTo` format) |
| 12 | BATT_AND_STORAGE | mv u16, used_kb u32, total_kb u32 |
| 13 | DEVICE_INFO | section 2 |
| 14 | PRIVATE_KEY | 64 bytes |
| 15 | DISABLED | - (feature compiled out) |
| 16 | CONTACT_MSG_RECV_V3 | snr4 i8, 0, 0, prefix6, path_len, txt_type, ts u32, [extra], text |
| 17 | CHANNEL_MSG_RECV_V3 | snr4 i8, 0, 0, ch_idx, path_len, txt_type (=0), ts u32, text |
| 18 | CHANNEL_INFO | idx u8, name[32], secret[16] |
| 19 | SIGN_START | reserved u8, max_len u32 (8192) |
| 20 | SIGNATURE | 64 bytes |
| 21 | CUSTOM_VARS | ASCII `"k:v,k:v"` (no NUL) |
| 22 | ADVERT_PATH | recv_ts u32, path_len, path bytes |
| 23 | TUNING_PARAMS | rx_delay x1000 u32, airtime_factor x1000 u32 |
| 24 | STATS | stats_type u8, then body (see config.md) |
| 25 | AUTOADD_CONFIG | bitmask u8, max_hops u8 |
| 26 | ALLOWED_REPEAT_FREQ | (lower_kHz u32, upper_kHz u32) x n |
| 27 | CHANNEL_DATA_RECV | snr4, 0, 0, ch_idx, path_len, data_type u16, data_len u8, data |
| 28 | DEFAULT_FLOOD_SCOPE | [name[31], key16], or empty when unset |
| 29 | CLI_REPLY | (1.18+) reply text |

Notes on message frames (7, 8, 16, 17, 27). These are queued: the radio sends push 0x83 and the
host must then pull each frame with `CMD_SYNC_NEXT_MESSAGE`.

- `path_len` is the packet's encoded path_len (hash size and hop count; see
  paths-and-trace.md) if the packet arrived **flood**. It is **0xFF if the packet arrived
  direct**. So 0xFF means "routed direct", not "flood".
- `txt_type`: 0 = PLAIN, 1 = CLI_DATA (replies from repeaters and rooms), 2 = SIGNED_PLAIN
  (room-server posts). For 2, `extra` is the 4-byte pubkey prefix of the post's **author**, and
  it sits before the text. In 1.18 there is also 3 = CLI_COMMAND.
- The text is not NUL-terminated and is clamped so the frame fits in 176 bytes.
- The offline queue holds 16 frames (`OFFLINE_QUEUE_SIZE`). When it is full, the oldest
  *channel* message is dropped to make room. If the queue holds no channel messages, the new
  frame is dropped.

## 5. Push codes (radio -> host, unsolicited)

| Code | Name | Layout (after code) |
|---|---|---|
| 0x80 | ADVERT | pubkey32 (known contact re-advertised) |
| 0x81 | PATH_UPDATED | pubkey32 (contact's out_path changed) |
| 0x82 | SEND_CONFIRMED | ack u32 (matches SENT.tag of a DM), round_trip_ms u32 |
| 0x83 | MSG_WAITING | - (call SYNC_NEXT_MESSAGE until NO_MORE_MESSAGES) |
| 0x84 | RAW_DATA | snr4 i8, rssi i8, 0xFF reserved, payload |
| 0x85 | LOGIN_SUCCESS | see repeaters-and-rooms.md (8 or 14 bytes total) |
| 0x86 | LOGIN_FAIL | 0, prefix6 |
| 0x87 | STATUS_RESPONSE | 0, prefix6, status struct |
| 0x88 | LOG_RX_DATA | snr4 i8, rssi i8, raw over-the-air packet |
| 0x89 | TRACE_DATA | see paths-and-trace.md |
| 0x8A | NEW_ADVERT | contact record (section 6). Means "not in contacts" (manual-add mode, hop limit, or table full) |
| 0x8B | TELEMETRY_RESPONSE | 0, prefix6, CayenneLPP bytes |
| 0x8C | BINARY_RESPONSE | 0, tag u32, response bytes |
| 0x8D | PATH_DISCOVERY_RESPONSE | 0, prefix6, out_path_len, out_path, in_path_len, in_path |
| 0x8E | CONTROL_DATA | snr4 i8, rssi i8, path_len, control payload |
| 0x8F | CONTACT_DELETED | pubkey32 (overwritten because the table was full) |
| 0x90 | CONTACTS_FULL | - |

## 6. Contact record

This layout is shared by `RESP_CODE_CONTACT` (3), `PUSH_CODE_NEW_ADVERT` (0x8A) and the
`CMD_ADD_UPDATE_CONTACT` (9) request. It is built by `writeContactRespFrame` and parsed by
`updateContactFromFrame`. The record is 148 bytes long, including the code byte.

| Off | Size | Type | Field |
|---|---|---|---|
| 0 | 1 | u8 | code |
| 1 | 32 | bytes | public key |
| 33 | 1 | u8 | type: 0 none, 1 chat, 2 repeater, 3 room, 4 sensor |
| 34 | 1 | u8 | flags: bit0 favourite. Bits 1..3 are telemetry permission bits granted to this contact (`TELEM_PERM_* << 1`). 1.18: bit4 allows remote CLI |
| 35 | 1 | u8 | out_path_len (encoded; 0xFF = unknown, so flood) |
| 36 | 64 | bytes | out_path (always 64 bytes, only the first `hash_size*count` are meaningful) |
| 100 | 32 | char[32] | name, NUL-padded |
| 132 | 4 | u32 | last_advert_timestamp (their clock) |
| 136 | 4 | i32 | lat x 1e6 |
| 140 | 4 | i32 | lon x 1e6 |
| 144 | 4 | u32 | lastmod (our clock) |

The minimum length for ADD_UPDATE_CONTACT is 36. Lat/lon are applied only if at least 8 more
bytes follow last_advert, and lastmod only if 4 more bytes follow that. Without them, lastmod
defaults to the current time. The firmware does not use the room `sync_since` value carried
in this record.

## 7. Error codes (`RESP_CODE_ERR`, second byte)

| Code | Name | Typical cause |
|---|---|---|
| 1 | UNSUPPORTED_CMD | unknown code, frame too short, unsupported txt_type |
| 2 | NOT_FOUND | contact / channel not found |
| 3 | TABLE_FULL | packet pool exhausted (send failed), contacts full |
| 4 | BAD_STATE | contact iterator busy, SIGN_DATA without SIGN_START |
| 5 | FILE_IO_ERROR | storage write failed |
| 6 | ILLEGAL_ARG | bad value, e.g. time going backwards |

## 8. Request/response correlation: only one request at a time

`CMD_SEND_LOGIN`, `CMD_SEND_STATUS_REQ`, `CMD_SEND_TELEMETRY_REQ` (remote),
`CMD_SEND_BINARY_REQ`, `CMD_SEND_ANON_REQ` and `CMD_SEND_PATH_DISCOVERY_REQ` all call
`clearPendingReqs()` before they record their own pending slot. So the radio tracks **only
one outstanding remote request at a time, across all kinds**. Two examples:

- Sending a status request while a login is in flight makes the login response unmatched,
  so it is silently dropped.
- Telemetry and binary responses match on `tag == pending_*`. Login and status responses
  match on the first 4 bytes of the target pubkey (`pending_login`, `pending_status`).

Serialise these requests on the host side: one request in flight, then wait for its push or
for `est_timeout_ms` from `RESP_CODE_SENT` (plus some margin) before sending the next.

`est_timeout_ms` is computed in `MyMesh::calcFloodTimeoutMillisFor` and
`calcDirectTimeoutMillisFor`:

- flood: `500 + 16 * airtime_ms`
- direct: `500 + (airtime_ms*6 + 250) * (hops+1)`

## 9. Differences in companion-v1.18.0 (FIRMWARE_VER_CODE 14)

- `CMD_RUN_CLI_COMMAND` (66) runs a CLI command **on the companion itself** and replies with
  `RESP_CODE_CLI_REPLY` (29) followed by the text. The supported commands are `get/set name`,
  `set pin`, `ver`, `board`, `get/set tz.offset`, radio prefs commands, `reboot` and WiFi
  settings.
- New `TXT_TYPE_CLI_COMMAND = 3`. It is accepted by `CMD_SEND_TXT_MSG`. A companion that
  receives one either runs it, if the sender contact has flags bit `0x10`, or queues it.
- A response that matches no pending request is now forwarded as `PUSH_CODE_BINARY_RESPONSE`
  `[0x8C][0][full response incl. 4-byte tag]` instead of being dropped.
- `CMD_SEND_RAW_DATA` now takes an *encoded* path_len, validated with `isValidPathLen`.
  In 1.17.1 it is treated as a raw byte count.
- The companion honours configurable `tx_delay_factor`, `direct_tx_delay_factor`,
  interference threshold and CAD.
- The repeater `RepeaterStats` struct is unchanged in repeater-v1.18.0.
