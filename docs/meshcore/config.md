# Companion configuration over the companion protocol

This document lists every setting a host can read or write on the companion, with the
command layouts. The source is `examples/companion_radio/MyMesh.cpp` (`handleCmdFrame`,
`begin`) and `NodePrefs.h` at `companion-v1.17.1`. Integers are little-endian. Settings are
persisted to flash immediately (`savePrefs()`) unless a row says otherwise.

## 1. Read-back sources

| Setting | Where to read it |
|---|---|
| name, tx power, max tx power, lat/lon, multi_acks, advert_loc_policy, telemetry modes, manual_add_contacts, freq, bw, sf, cr | `SELF_INFO` (reply to APP_START); companion-protocol.md, section 2 |
| client repeat, path_hash_mode, BLE pin (stored), max contacts/channels, firmware version | `DEVICE_INFO` (reply to DEVICE_QUERY) |
| rx_delay_base, airtime_factor | `CMD_GET_TUNING_PARAMS` (43) |
| auto-add bitmask, auto-add max hops | `CMD_GET_AUTOADD_CONFIG` (59) |
| default flood scope | `CMD_GET_DEFAULT_FLOOD_SCOPE` (64) |
| custom vars (gps) | `CMD_GET_CUSTOM_VARS` (40) |
| channels | `CMD_GET_CHANNEL` (31) for idx 0..max_channels-1 |
| time | `CMD_GET_DEVICE_TIME` (5) |

Some settings **cannot be read back over the protocol**: the session flood-scope key, the
active BLE pin when it is random or the build default, the buzzer/vibe quiet flags, the
gps interval and the FEM gains.

## 2. Radio

| Command | Layout | Validation / behaviour |
|---|---|---|
| `CMD_SET_RADIO_PARAMS` (11) | `[11][freq u32 kHz][bw u32 Hz][sf u8][cr u8][repeat u8, optional, v9+]` | `150000 <= freq <= 2500000`, `7000 <= bw <= 500000`, sf 5-12, cr 5-8, otherwise ERR(6). Applied **immediately** (`radio_driver.setParams`), no reboot. Example: 869.525 MHz / 250 kHz is `freq = 869525`, `bw = 250000`. |
| (repeat flag) | 5th param above | `repeat != 0` enables **client repeat**, i.e. the companion forwards packets. It is accepted only if `freq` (kHz) is inside an allowed range. Otherwise ERR(6). Omitting the byte **disables** repeat. |
| `CMD_GET_ALLOWED_REPEAT_FREQ` (60) | `[60]` | Reply `[26]` followed by `(lower_kHz u32, upper_kHz u32)` pairs. The default build gives `433000-433000`, `869495-869495` and `918000-918000`: exact frequencies, not bands. Builds can override this with `ALLOWED_REPEAT_FREQ_RANGE`. |
| `CMD_SET_RADIO_TX_POWER` (12) | `[12][dBm i8]` | Range -9..`MAX_LORA_TX_POWER` (SELF_INFO byte 3), otherwise ERR(6). Applied immediately. |
| `CMD_SET_TUNING_PARAMS` (21) | `[21][rx_delay_base x1000 u32][airtime_factor x1000 u32]` | No validation on write. On boot the values are clamped to rx_delay 0..20 and af 0..9. Defaults are af = 1.0 and rx_delay = 0. |
| `CMD_GET_TUNING_PARAMS` (43) | `[43]` | Reply `[23][rx_delay x1000 u32][af x1000 u32]`. |
| `CMD_SET_PATH_HASH_MODE` (61) | `[61][0 reserved][mode u8]` | mode 0, 1 or 2 means 1, 2 or 3-byte hop hashes on floods this node originates. mode >= 3 gives ERR(6). Byte 1 must be 0, otherwise ERR(1). |
| (no command) | | RX boosted gain and FEM gains are prefs-only; there is no protocol command in 1.17.1. 1.18 exposes some of them via `CMD_RUN_CLI_COMMAND`. |

## 3. Identity and advert

| Command | Layout | Notes |
|---|---|---|
| `CMD_SET_ADVERT_NAME` (8) | `[8][name bytes]` | Truncated to 31 bytes. Not validated in 1.17.1. |
| `CMD_SET_ADVERT_LATLON` (14) | `[14][lat i32 x1e6][lon i32 x1e6][alt i32, optional, ignored]` | Out-of-range values give ERR(6). Changes the location used for adverts and `SELF_INFO`. |
| `CMD_SEND_SELF_ADVERT` (7) | `[7]` or `[7][1]` | `[7][1]` sends a flood advert, scoped by the **default** flood scope. Anything else sends zero-hop. |
| advert location policy | via `CMD_SET_OTHER_PARAMS` byte 3 | 0 = `ADVERT_LOC_NONE` (no location in adverts), 1 = `ADVERT_LOC_SHARE` (include lat/lon). |
| `CMD_EXPORT_PRIVATE_KEY` (23) / `CMD_IMPORT_PRIVATE_KEY` (24) | `[23]` / `[24][64 bytes]` | Reply `RESP_DISABLED` (15) unless built with `ENABLE_PRIVATE_KEY_EXPORT` / `ENABLE_PRIVATE_KEY_IMPORT`. |
| `CMD_EXPORT_CONTACT` (17) with no key | `[17]` | Returns our own advert as a raw packet, `[11][packet]`. Useful for QR or sharing. |
| `CMD_SIGN_START` (33), `SIGN_DATA` (34), `SIGN_FINISH` (35) | `[33]`, `[34][chunk]`..., `[35]` | Ed25519 signature over up to 8192 bytes. The reply to `[35]` is `[20][sig 64]`. |

## 4. "Other params" (`CMD_SET_OTHER_PARAMS`, 38)

```
[38][manual_add_contacts u8][telemetry_modes u8 (v5+)][advert_loc_policy u8][multi_acks u8 (v7+)]
```

Trailing bytes are optional. Fields that are omitted are **left unchanged**, except
`manual_add_contacts`, which is always written. Every write persists and replies OK. To
change a single field, read SELF_INFO first and send all four bytes.

| Field | Values |
|---|---|
| manual_add_contacts | bit0: 0 = auto-add every advert type; 1 = manual mode, where auto-add is controlled by the autoadd bitmask (section 5) |
| telemetry_modes | `env<<4 \| loc<<2 \| base`, each 0 deny / 1 per-contact flags / 2 allow all (telemetry.md, section 4) |
| advert_loc_policy | 0 none / 1 share |
| multi_acks | 0 or 1 (`getExtraAckTransmitCount`): when >0, direct ACKs are preceded by an extra MULTIPART ACK 300 ms earlier |

## 5. Contacts: auto-add

| Command | Layout | Notes |
|---|---|---|
| `CMD_SET_AUTOADD_CONFIG` (58) | `[58][bitmask u8][max_hops u8, optional]` | max_hops is clamped to 64. 0 = no limit, 1 = only direct (0-hop) adverts, N = up to N-1 hops. The hop limit applies in every mode. |
| `CMD_GET_AUTOADD_CONFIG` (59) | `[59]` | Reply `[25][bitmask][max_hops]`. |

Bitmask bits:

| Bit | Meaning |
|---|---|
| 0x01 | when the contacts table is full, overwrite the oldest non-favourite contact (sends `PUSH_CONTACT_DELETED` 0x8F); otherwise sends `PUSH_CONTACTS_FULL` 0x90 |
| 0x02 | in manual mode, auto-add CHAT |
| 0x04 | in manual mode, auto-add REPEATER |
| 0x08 | in manual mode, auto-add ROOM |
| 0x10 | in manual mode, auto-add SENSOR |

An advert that is not added still produces `PUSH_NEW_ADVERT` (0x8A) with the full contact
record, so the host can offer an "add" action. The host adds it with
`CMD_ADD_UPDATE_CONTACT` (9) or `CMD_IMPORT_CONTACT` (18).

## 6. Channels

| Command | Layout | Notes |
|---|---|---|
| `CMD_GET_CHANNEL` (31) | `[31][idx]` | Reply `[18][idx][name 32][secret 16]`. Any idx below `MAX_GROUP_CHANNELS` succeeds, even if the slot is unused (name "" and an all-zero secret). The name field is written with `strcpy`, so **bytes after the NUL are stale**: parse it as a C string. |
| `CMD_SET_CHANNEL` (32) | `[32][idx][name 32, NUL-padded][secret 16]` | Frame length is 50..65. **A length of 66 or more (a 32-byte secret) gives ERR(1)**, because only 128-bit secrets are supported. A bad idx gives ERR(2). The channel hash is `sha256(secret)[0]`. |
| remove a channel | `CMD_SET_CHANNEL` with an empty name and a zero secret | There is no delete command. This convention is assumed (**unverified** against the official apps). Slot 0 is preloaded as "Public" with PSK `izOH6cXN6mrJ5e26oRXNcg==` (base64) at boot, before the stored channels are loaded. |
| hashtag channels | (host side) | The usual convention is `secret = sha256("#name")[0..16]`. The firmware does no derivation. **Unverified** against the official apps. |

## 7. Flood scope (regions, 1.10+)

| Command | Layout | Notes |
|---|---|---|
| `CMD_SET_FLOOD_SCOPE_KEY` (54) | `[54][0][key 16]` | Session-only override: floods are sent with `transport_codes[0] = HMAC-SHA256(key, payload_type \|\| payload)[0..2]` (0x0000 and 0xFFFF are avoided). **Not persisted.** |
| | `[54][0]` (length < 18) | Clears the override, falling back to the default scope. |
| | `[54][1]` | v12+: send floods **unscoped**, ignoring the default. |
| `CMD_SET_DEFAULT_FLOOD_SCOPE` (63) | `[63][name 31 bytes, NUL-terminated/padded][key 16]` (length 48) | Persisted. The name must be 1..30 chars, otherwise ERR(6). `[63]` alone clears it. The key for a public "#region" is `sha256("#" + name)[0..16]` (`TransportKeyStore::getAutoKeyFor`). |
| `CMD_GET_DEFAULT_FLOOD_SCOPE` (64) | `[64]` | Reply `[28][name 31][key 16]`, or just `[28]` if unset. |

## 8. Device

| Command | Layout | Notes |
|---|---|---|
| `CMD_SET_DEVICE_TIME` (6) | `[6][epoch u32]` | **Rejected with ERR(6) if earlier than the current RTC.** The clock can only move forward over the protocol. At boot the RTC is bootstrapped to the newest contact `lastmod` + 1. |
| `CMD_GET_DEVICE_TIME` (5) | `[5]` | Reply `[9][epoch u32]`. |
| `CMD_SET_DEVICE_PIN` (37) | `[37][pin u32]` | 0 (use the build default) or 100000..999999, otherwise ERR(6). In 1.17.1 the active BLE PIN is chosen in `begin()`, so the change **takes effect after reboot**. With `ble_pin == 0`, a display board whose default PIN is 123456 gets a random PIN each boot (shown on screen). |
| BLE name | (none) | Not settable over the protocol. The BLE name is derived from the node name with the `"MeshCore-"` prefix (`BLE_NAME_PREFIX`); exact composition **unverified**. |
| `CMD_GET_BATT_AND_STORAGE` (20) | `[20]` | Reply `[12][mV u16][used_kb u32][total_kb u32]`. |
| `CMD_GET_STATS` (56) | `[56][type]` | type 0 (core) replies `[24][0][batt_mv u16][uptime_s u32][err_flags u16][tx_queue_len u8]` (11 bytes). type 1 (radio) replies `[24][1][noise_floor i16][last_rssi i8][last_snr4 i8][tx_air_s u32][rx_air_s u32]` (14 bytes). type 2 (packets) replies `[24][2][recv u32][sent u32][sent_flood u32][sent_direct u32][recv_flood u32][recv_direct u32][recv_errors u32]` (30 bytes). Any other type gives ERR(6). |
| `CMD_SET_CUSTOM_VAR` (41) / `CMD_GET_CUSTOM_VARS` (40) | `"name:value"` | GPS on/off is `gps:1` / `gps:0`; it also persists `gps_enabled`. When GPS is active, its position feeds `SELF_INFO` lat/lon and adverts. |
| `CMD_REBOOT` (19) | `[19]["reboot"]` | Flushes dirty contacts, then reboots. No reply. |
| `CMD_FACTORY_RESET` (51) | `[51]["reset"]` | Disables the serial interface, formats the file system, sends OK, then reboots after 1 s. **Destroys the identity.** |

## 9. Persisted prefs reference (`NodePrefs.h`, JSON-serialised in 1.17.1)

```
name, lat, lon,
radio{freq, bw, sf, cr, rxgain, tx, af, rxdelay, hash_mode, multi_ack},
gps{en, int, adv_loc},
repeat{disable},
comp{auto_max, defs_nm, defs_key, pin, buzz_q, vibe_q, auto_add, man_add, tel_base, tel_loc, tel_env}
```

These keys are internal storage only and cannot be reached through the protocol except
through the commands above.
