# CLI over LoRa (remote admin of repeaters and room servers)

This document covers sending CLI commands to a repeater or room server over LoRa, and lists
the commands those servers accept.

Sources, at `companion-v1.17.1` / `v1.17.1`:

- `examples/companion_radio/MyMesh.cpp` (the `CMD_SEND_TXT_MSG` CLI branch)
- `src/helpers/BaseChatMesh.cpp` (`sendCommandData`, `onPeerDataRecv`)
- `examples/simple_repeater/MyMesh.cpp` and `examples/simple_room_server/MyMesh.cpp`
  (`onPeerDataRecv`, `handleCommand`)
- `src/helpers/CommonCLI.cpp` (`handleCommand`, `handleSetCmd`, `handleGetCmd`,
  `handleRegionCmd`)

## 1. Sending a command

**Prerequisite:** log in as **admin** first (see repeaters-and-rooms.md). CLI text from
non-admin ACL members is dropped silently. Senders that are not in the ACL can't even be
decrypted.

`CMD_SEND_TXT_MSG` (2) with `txt_type = 1` (`TXT_TYPE_CLI_DATA`):

| Off | Size | Field |
|---|---|---|
| 0 | 1 | 2 |
| 1 | 1 | txt_type = 1 |
| 2 | 1 | attempt (only the low 2 bits are used) |
| 3 | 4 | timestamp u32. **Ignored for CLI**: the radio substitutes its own `getCurrentTimeUnique()` to avoid replay rejection |
| 7 | 6 | contact pubkey prefix6 |
| 13 | n | command text (no NUL; max 160 bytes, `MAX_TEXT_LEN`) |

The minimum frame length is 14. The reply is `RESP_CODE_SENT`
`[6][flood][expected_ack u32 = 0][est_timeout_ms u32]`. **No ACK is expected** for CLI data,
so `PUSH_SEND_CONFIRMED` never comes.

On air, this is `PAYLOAD_TYPE_TXT_MSG` with plaintext
`[ts u32][(1<<2) | (attempt&3)][text]`, sent direct if the contact has a path and flood
otherwise.

### Server-side handling (repeater `onPeerDataRecv`)

- Accepted txt flags are PLAIN (0, the legacy form, which also gets an ACK) and CLI_DATA (1).
- Replay rule: `sender_timestamp >= last_timestamp`. If the timestamp is **equal**, the
  command is treated as a retry and **not executed**, and the reply is empty, so nothing is
  sent back. In practice: to resend a command, send it again normally. The radio's unique
  timestamp then makes it a new command, and it will be executed twice.
- Commands from a remote sender always have `sender_timestamp > 0`. Commands gated on
  `sender_timestamp == 0` are therefore **local serial only**: `erase`, `log` (dump),
  `stats-core`, `stats-radio`, `stats-packets`, `get prv.key`, `set freq`, `get acl`. Remote
  clients should use the binary status request instead of the `stats-*` commands.

### Reply

The server answers with a `PAYLOAD_TYPE_TXT_MSG` whose plaintext is
`[server_ts u32][1<<2][reply text]`:

- Repeaters wait 600 ms (`CLI_REPLY_DELAY_MILLIS`) before replying. Rooms wait 300 ms, plus
  any ACK delay.
- The reply goes direct along the stored out_path, or as a flood if no out_path is stored.
- An empty reply sends nothing. Examples are `reboot`, which reboots before replying, and the
  lines of a `region load` block.
- The reply text is at most about 160 bytes.

The companion (`BaseChatMesh::onPeerDataRecv`, flags == CLI_DATA):

1. Does **not** ACK the reply.
2. If the reply arrived by flood, sends a PATH return so that later traffic goes direct.
3. Queues `RESP_CODE_CONTACT_MSG_RECV_V3` `[16][snr4][0][0][prefix6][path_len][txt_type=1][ts][text]`
   and emits `PUSH_MSG_WAITING` (0x83).
4. The host fetches the reply with `CMD_SYNC_NEXT_MESSAGE` and recognises it by
   `txt_type == 1` from that contact.

### Correlating replies

CLI replies carry no request id. Two options:

- Keep **one CLI command in flight per server** and treat the next `txt_type=1` message from
  that contact as its reply.
- Use the **prefix echo**. If a command has `command[2] == '|'` and is longer than 4 chars,
  for example `"a7|get name"`, the server strips the first 3 chars and copies them to the
  start of the reply, giving `"a7|> MyNode"`. The prefix is any 2 characters plus `|`. This
  is the mechanism official apps use (repeater and room `handleCommand`).

The ACL `setperm`, the repeater's `discover.neighbors` and the room's `room.post` are checked
**after** the prefix is stripped, so they work with a prefix too.

## 2. Command catalogue (repeater and room, v1.17.1)

Notation: `<x>` is a required argument, `[x]` is optional. "Local" means local serial only
(`sender_timestamp == 0`). Reply strings are given verbatim where useful. Matching uses
`memcmp` on the prefix, so trailing text after a matched prefix is often ignored.

### 2.1 Operations (`CommonCLI::handleCommand`)

| Command | Effect / reply |
|---|---|
| `reboot` | reboots immediately (no reply) |
| `poweroff` / `shutdown` | powers off the board if supported (no reply) |
| `clkreboot` | sets the clock to 1715770351 and reboots |
| `advert` | flood advert after 1.5 s: `"OK - Advert sent"` |
| `advert.zerohop` | zero-hop advert: `"OK - zerohop advert sent"` |
| `clock` | `"HH:MM - D/M/YYYY UTC"` |
| `clock sync` | sets the clock to the **sender's message timestamp + 1**, only if that is ahead of the current time. Otherwise replies `"ERR: clock cannot go backwards"`. Because the companion substitutes its own RTC time, this syncs to the **companion's** clock |
| `time <epoch>` | sets the clock if it moves forward; otherwise replies `"(ERR: clock cannot go backwards)"` |
| `neighbors` | repeater: lines of `"<pubkey 4B hex>:<secs_ago>:<snr x4>"`, newest first, about 134 chars max, or `"-none-"`. Room: not overridden (no neighbour table). |
| `neighbor.remove <hex prefix>` | repeater: removes matching neighbours. Reply `"OK"`. |
| `discover.neighbors` | repeater only: sends a zero-hop node-discover control packet; responses fill the neighbour table. Reply `"OK - Discover sent"` |
| `tempradio <freq> <bw> <sf> <cr> <mins>` | temporary radio params, applied after 2 s and reverted after `mins` |
| `password <new>` | sets the admin password (max 15 chars). Reply `"password now: <pw>"` |
| `clear stats` | `"(OK - stats reset)"` |
| `ver` | `"v1.17.1 (Build: <date>)"` |
| `board` | manufacturer name |
| `start ota` | board-specific OTA start (nRF52/ESP32), or `"Error"` |
| `sensor get <key>` / `sensor set <key> <value>` / `sensor list [start]` | custom sensor vars |
| `gps` / `gps on` / `gps off` / `gps sync` / `gps setloc` / `gps advert [none\|share\|prefs]` | only when built with GPS |
| `powersaving [on\|off]` | repeater power saving (nRF52 takes effect immediately, ESP32 after 2 min) |
| `log start` / `log stop` / `log erase` | packet log to flash. `log` (dump) is local only. |
| `region ...` | see 2.4 |
| `setperm <pubkey-hex> <perm>` | ACL edit (repeater, room). Role 0 removes the entry; any other role needs the full 64-hex key. Replies `"OK"`, `"Err - bad params"`, `"Err - invalid params"` or `"Err - bad pubkey"` |
| `room.post <text>` | room only: adds a system post. Reply `"OK"` |
| `erase` | local only: format the file system |

Unknown commands reply `"Unknown command"`.

### 2.2 `get <key>` (`handleGetCmd`)

Replies look like `"> <value>"`. An unknown key replies `"??: <key>"`.

| Key | Value |
|---|---|
| `name` | node name |
| `role` | `repeater` / `room_server` / (sensor) |
| `public.key` | 64 hex chars |
| `prv.key` | local only |
| `radio` | `freq,bw,sf,cr` (bw with 3 decimals) |
| `freq` | MHz |
| `tx` | dBm |
| `radio.rxgain` | on/off |
| `radio.fem.rxgain` / `radio.fem.txgain` | on/off, or `"Error: unsupported"` |
| `lat` / `lon` | degrees |
| `repeat` | on/off |
| `af` | airtime factor |
| `dutycycle` | `"> 50.0%"` (= 100/(af+1)) |
| `rxdelay` / `txdelay` / `direct.txdelay` | floats |
| `int.thresh` | interference threshold |
| `cad` | on/off |
| `agc.reset.interval` | seconds (stored /4) |
| `multi.acks` | 0/1 |
| `allow.read.only` | on/off (room) |
| `advert.interval` | minutes (stored /2) |
| `flood.advert.interval` | hours |
| `flood.max` / `flood.max.unscoped` / `flood.max.advert` | hop limits |
| `guest.password` | **returned in clear** |
| `owner.info` | text with newlines shown as `\|` |
| `path.hash.mode` | 0..2 |
| `loop.detect` | off/minimal/moderate/strict |
| `bridge.type` | none/rs232/espnow |
| `bridge.enabled` / `bridge.delay` / `bridge.source` / `bridge.baud` / `bridge.channel` / `bridge.secret` | bridge builds only |
| `bootloader.ver` | nRF52 only |
| `adc.multiplier` | float, or `"Error: unsupported"` |
| `pwrmgt.support` / `pwrmgt.source` / `pwrmgt.bootreason` / `pwrmgt.bootmv` | nRF52 power management |
| `extra.sf` | LR2021 only |

Matching is by prefix, in source order. `get radio.rxgain` is tested before `get radio`.

### 2.3 `set <key> <value>` (`handleSetCmd`)

Most keys reply `"OK"`. An unknown key replies `"unknown config: <key>"`.

| Key | Arg / range | Notes |
|---|---|---|
| `name <s>` | rejects `[ ] \ : , ? *` | |
| `radio <freq> <bw> <sf> <cr>` | 150-2500 MHz, 7-500 kHz, sf 5-12, cr 5-8 | `"OK - reboot to apply"` |
| `freq <MHz>` | | local only |
| `tx <dBm>` | | applied immediately |
| `radio.rxgain on\|off` | | |
| `radio.fem.rxgain on\|off` / `radio.fem.txgain on\|off` | | board-dependent |
| `lat <deg>` / `lon <deg>` | | used when advert loc policy is `prefs` |
| `repeat on\|off` | | |
| `af <f>` | | airtime factor |
| `dutycycle <1-100>` | | sets `af = 100/dc - 1` |
| `rxdelay <0-20>` / `txdelay <0-2>` / `direct.txdelay <0-2>` | | |
| `int.thresh <n>` | | |
| `cad on\|off` | | |
| `agc.reset.interval <secs>` | | rounded to a multiple of 4 |
| `multi.acks <n>` | | |
| `allow.read.only on\|off` | | room |
| `advert.interval <mins>` | 0 = off, else 60-240 | |
| `flood.advert.interval <hours>` | 0 = off, else 3-168 | |
| `flood.max <0-64>` / `flood.max.unscoped <0-64>` / `flood.max.advert <0-64>` | | |
| `guest.password <s>` | max 15 chars | |
| `prv.key <128 hex>` | | `"OK, reboot to apply! New pubkey: ..."` |
| `owner.info <text>` | `\|` becomes a newline | max 119 chars |
| `path.hash.mode <0-2>` | | path hash bytes = mode + 1 |
| `loop.detect off\|minimal\|moderate\|strict` | | |
| `adc.multiplier <f>` | 0 = board default | |
| `bridge.enabled\|delay\|source\|baud\|channel\|secret ...` | | bridge builds only |
| `extra.sf <sf,...>` | | LR2021 only |

Side effect: any save via `CommonCLI::savePrefs()` turns the local advert interval off if it
is below 60 minutes, because "the device has been manually configured".

### 2.4 Regions (`handleRegionCmd`, v1.10+)

| Command | Effect |
|---|---|
| `region` | dumps the region tree, up to 160 chars |
| `region load` | the following CLI lines (indented names, optional `F`) define a new map; a blank line ends the block |
| `region save` | persists the map and bumps `discovery_mod_timestamp` |
| `region allowf <name>` / `region denyf <name>` | allow or deny flooding for a region |
| `region get <name>` | `" name (parent) F"` |
| `region home [<name>]` | get or set the home region |
| `region default [<name>\|<null>]` | get or set the default flood scope; auto-creates the region |
| `region put <name> [<parent>]` | creates a region with flood allowed |
| `region remove <name>` | removes a region, or replies `"Err - not empty"` |
| `region list allowed\|denied` | lists region names |
| `region def <name>[,jump] ...` | single-line hierarchy definition |

### 2.5 Sensor nodes

`simple_sensor` has its own command set: alert and threshold commands on top of the common
ones. It was not catalogued here and is **unverified**.

## 3. Companion-local CLI

In 1.17.1, `MyMesh::checkCLIRescueCmd` is reachable only in "CLI rescue" mode on the USB
console, not through the frame protocol. Its commands are `set pin`, `rebuild`, `erase`,
`ls`, `cat`, `rm` and `reboot`.

**1.18.0** adds `CMD_RUN_CLI_COMMAND` (66). It runs a local command and returns
`RESP_CODE_CLI_REPLY` (29) followed by the text. The commands available that way are
`get/set name`, `set pin`, `ver`, `board`, `get/set tz.offset`, radio prefs commands,
`reboot`, `poweroff` and WiFi settings. 1.18 also adds `TXT_TYPE_CLI_COMMAND` (3), which lets
one companion administer another if the target's contact entry for the sender has flags bit
0x10.
