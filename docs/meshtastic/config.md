# Meshtastic configuration reference

Field-level reference for every `Config`, `ModuleConfig`, `Channel` and owner (`User`) setting,
plus the AdminMessage get/set flow and which writes reboot the node. Companion to
[advanced-features.md](advanced-features.md) (session keys, PKC, rate limits).

Sources: protobufs pinned by firmware `v2.7.15.567b8ea`, `v2.7.26.54e0d8d`, `v2.8.0.7239fe8`
and protobufs `master`; firmware `src/modules/AdminModule.cpp`, `src/mesh/NodeDB.cpp`
(`installDefaultConfig`, `installDefaultModuleConfig`, `installRoleDefaults`,
`initConfigIntervals`), `src/mesh/Default.h`, `src/mesh/Channels.cpp`,
`src/mesh/RadioInterface.cpp`, `src/mesh/MeshRadio.h`. Version labels as in
advanced-features.md.

Column conventions:
- **Default**: value after factory reset on a typical board (`installDefaultConfig`). "0" means
  the proto zero value is stored and the firmware substitutes the documented default at runtime.
  Board variants and `USERPREFS_*` build flags can change defaults.
- **Reboot**: whether changing this field via `set_config`/`set_module_config` outside an edit
  transaction reboots the node (7 s later). See §2.3 for the exact rule per section.
- "proto ≥ X" = field exists in the protobufs pinned by firmware X.

---

## 1. How settings travel

| Direction | Carrier |
|---|---|
| Node → client at connect | `FromRadio.config (5)` one per section, `FromRadio.moduleConfig (9)` one per section, `FromRadio.channel (10)` × 8, own `FromRadio.node_info (4)` (owner `User`). |
| Read on demand | `AdminMessage.get_config_request (5)`, `get_module_config_request (7)`, `get_channel_request (1)`, `get_owner_request (3)` → `*_response`. |
| Write | `AdminMessage.set_config (34)`, `set_module_config (35)`, `set_channel (33)`, `set_owner (32)`, optionally wrapped in `begin_edit_settings (64)` … `commit_edit_settings (65)`. |

`Config` oneof: `device 1, position 2, power 3, network 4, display 5, lora 6, bluetooth 7,
security 8, sessionkey 9, device_ui 10`.

`ModuleConfig` oneof: `mqtt 1, serial 2, external_notification 3, store_forward 4, range_test 5,
telemetry 6, canned_message 7, audio 8, remote_hardware 9, neighbor_info 10, ambient_lighting 11,
detection_sensor 12, paxcounter 13, statusmessage 14 (proto ≥ 2.7.26), traffic_management 15
(proto ≥ 2.7.26), tak 16 (proto ≥ 2.7.26), mesh_beacon 17 (proto ≥ 2.8.0)`.

`AdminMessage.ConfigType` (0-based, for `get_config_request`): `DEVICE_CONFIG 0, POSITION_CONFIG 1,
POWER_CONFIG 2, NETWORK_CONFIG 3, DISPLAY_CONFIG 4, LORA_CONFIG 5, BLUETOOTH_CONFIG 6,
SECURITY_CONFIG 7, SESSIONKEY_CONFIG 8, DEVICEUI_CONFIG 9` — i.e. `oneof tag − 1`.

`AdminMessage.ModuleConfigType` (0-based): `MQTT 0, SERIAL 1, EXTNOTIF 2, STOREFORWARD 3,
RANGETEST 4, TELEMETRY 5, CANNEDMSG 6, AUDIO 7, REMOTEHARDWARE 8, NEIGHBORINFO 9,
AMBIENTLIGHTING 10, DETECTIONSENSOR 11, PAXCOUNTER 12, STATUSMESSAGE 13, TRAFFICMANAGEMENT 14,
TAK 15, MESHBEACON 16` — i.e. `oneof tag − 1`.

`DeviceMetadata.excluded_modules (12)` bitmask tells which sections the build lacks:
`MQTT 0x1, SERIAL 0x2, EXTNOTIF 0x4, STOREFORWARD 0x8, RANGETEST 0x10, TELEMETRY 0x20,
CANNEDMSG 0x40, AUDIO 0x80, REMOTEHARDWARE 0x100, NEIGHBORINFO 0x200, AMBIENTLIGHTING 0x400,
DETECTIONSENSOR 0x800, PAXCOUNTER 0x1000, BLUETOOTH 0x2000, NETWORK 0x4000` (master adds
`STATUSMESSAGE 0x8000, TRAFFICMANAGEMENT 0x10000, TAK 0x20000, MESHBEACON 0x40000`). Hide those
sections in the UI.

---

## 2. The admin write flow

### 2.1 Single write

```
ToRadio.packet { to = <own node num | remote node>, channel = 0, id = <fresh>, want_ack = false,
  decoded { portnum = ADMIN_APP (6), want_response = true,
            payload = AdminMessage { set_config = Config { lora = {...} },
                                     session_passkey = <8 bytes, remote only> } } }
```

- **Send the complete section.** The firmware replaces the whole sub-message
  (`config.lora = c.payload_variant.lora`); omitted fields become 0/false. Read the section first,
  modify, write back.
- Strings equal to `"sekrit"` in `network.wifi_psk` (2.8) and `mqtt.password` (2.8) mean "keep
  current value" (`writeSecret`). 2.7.x: `wifi_psk = "sekrit"` is written literally.
- `want_response = true` yields a `Routing{error_reason = NONE}` reply (or an error such as
  `BAD_REQUEST (32)`), `request_id = id`.
- Bluetooth is shut down on writes that will reboot (`disableBluetooth()`), irrelevant for
  serial clients except that BLE clients of the same node drop.

### 2.2 Edit transaction

```
begin_edit_settings = true
set_config {…} ; set_config {…} ; set_module_config {…} ; set_channel {…} ; set_owner {…}
commit_edit_settings = true      → saves everything, then reboots (always)
```

Inside the transaction nothing is saved and nothing reboots until commit. 2.8 auto-closes an idle
(60 s) transaction, saving without reboot (advanced-features.md §5.5).

### 2.3 Reboot matrix (`AdminModule::handleSetConfig`, `handleSetModuleConfig`)

`requiresReboot` starts `true`; a section clears it only under the listed condition.

| Section | No reboot when … (2.7.15 / 2.7.26) | 2.8.0 |
|---|---|---|
| device | `button_gpio`, `buzzer_gpio`, `role`, `rebroadcast_mode` all unchanged | same |
| position | never — always reboots | same |
| power | `device_battery_ina_address`, `is_power_saving`, `ls_secs`, `min_wake_secs`, `on_battery_shutdown_after_secs`, `sds_secs`, `wait_bluetooth_secs` all unchanged (i.e. only `adc_multiplier_override`/`powermon_enables` changed) | same |
| network | never — always reboots | same |
| display | `screen_on_secs`, `flip_screen`, `oled`, `displaymode` unchanged | same |
| lora | `use_preset`, `region`, `modem_preset`, `bandwidth`, `spread_factor`, `coding_rate`, `tx_power`, `frequency_offset`, `override_frequency`, `channel_num`, `sx126x_rx_boosted_gain` unchanged | **never reboots** — radio reconfigured live |
| bluetooth | never — always reboots | same |
| security | always "no reboot" (the comparison runs after the new value is copied in, so it is always equal) | **always reboots** |
| device_ui (via set_config) | ignored by firmware but still triggers reboot — use `store_ui_config (46)` instead | same |
| all module configs | always reboot, except `statusmessage` (2.7.26+) | also no reboot for `mesh_beacon` |
| `set_channel` | no reboot | no reboot |
| `set_owner` | reboots if anything changed | same |
| `set_ham_mode`, `restore_preferences`, factory resets, `nodedb_reset` | reboot | same |
| `set_fixed_position`, favourites, ignore, time | no reboot | same |

Region change additionally: on first set from `UNSET` the node generates its PKI keypair, enables
TX, sets `ignore_mqtt = true` for duty-cycle-limited regions, and rewrites `mqtt.root` from
`msh` to `msh/<REGION>` (if still default).

### 2.4 Values the firmware rewrites on write

| Field | Rule | Since |
|---|---|---|
| `device.rebroadcast_mode = NONE` with role ROUTER / ROUTER_LATE | forced `ALL`, warning "Rebroadcast mode can't be set to NONE for a router role" | 2.7.x (ROUTER_LATE since ≤2.7.26) |
| `device.role = ROUTER_CLIENT (3)` or `REPEATER (4)` | stored as `CLIENT`; if S&F enabled, `is_server = true` | 2.7.x |
| `device.role` changed | `installRoleDefaults(newRole)` rewrites intervals/rebroadcast/`is_unmessagable` (§3.1.1) | 2.7.x |
| `device.node_info_broadcast_secs < 3600` | → 3600 | 2.7.x |
| `power.on_battery_shutdown_after_secs` 1–29 | → 30 | 2.7.x |
| `lora.coding_rate` outside 4–8 (incl. 0) | → 5 | 2.7.26 (2.7.15: outside 4–8 → 5) |
| `lora.spread_factor` outside 5–12 (RF95: also 5, 6) | → 11 | 2.7.26 (2.7.15: outside 7–12 → 11) |
| `lora.bandwidth == 0` | 2.7.15: → 250 (812 on 2.4 GHz); 2.7.26: kept 0 (radio uses 250); 2.8: clamped only when `use_preset = false` | |
| invalid region/preset combination | 2.8: local client → clamped to region default preset; remote → whole LoRa change rejected (EU_868/EU_866/EU_N_868 presets swap the region) | 2.8 |
| `lora.region = LORA_24` on a sub-GHz radio | 2.8: `BAD_REQUEST` | 2.8 |
| `security.is_managed = true` without any admin key | cleared, warning | 2.7.x |
| `security.private_key` not 32 bytes | 2.7.x: new keypair generated; 2.8: existing keypair kept (regeneration requires sending a new 32-byte private key) | |
| display mode → `COLOR` | `bluetooth.enabled = false` | 2.7.x |
| `neighbor_info.update_interval < 14400` | → 21600 (not 14400) | 2.7.x |
| `mesh_beacon.broadcast_interval_secs` 1–3599 | → 3600; message cut at 100 chars; invalid preset/region/channel entries cleared | 2.8 |

Boot-time coercion (`NodeDB` load): if any channel is the default public channel on the default
slot, telemetry intervals (`device/environment/air_quality/power/health`) are raised to ≥ 1800 s
(43200 s for ROUTER/ROUTER_LATE); if positions would go out on a default channel,
`position_broadcast_secs ≥ 3600` (43200 router) and `broadcast_smart_minimum_interval_secs ≥ 300`.
Intervals above `INT32_MAX` are clamped to `INT32_MAX`.

---

## 3. Config sections

### 3.1 DeviceConfig (`Config.device = 1`)

| # | Field | Type | Values / units | Default | Reboot | Notes |
|---|---|---|---|---|---|---|
| 1 | `role` | `Role` | see below | `CLIENT` | yes | Role change installs role defaults (§3.1.1). |
| 2 | `serial_enabled` | bool | | — | | Deprecated, moved to `security.serial_enabled`. |
| 4 | `button_gpio` | uint32 | GPIO | 0 = board pin | yes | |
| 5 | `buzzer_gpio` | uint32 | GPIO | 0 = board pin | yes | |
| 6 | `rebroadcast_mode` | `RebroadcastMode` | below | `ALL` | yes | |
| 7 | `node_info_broadcast_secs` | uint32 | s | 10800 | no | Min 3600 enforced. |
| 8 | `double_tap_as_button_press` | bool | | false | no | Accelerometer. |
| 9 | `is_managed` | bool | | — | | Deprecated, moved to `security.is_managed`. |
| 10 | `disable_triple_click` | bool | | false | no | Triple-click toggles GPS. |
| 11 | `tzdef` | string ≤ 64 | POSIX TZ, e.g. `EET-2EEST,M3.5.0/3,M10.5.0/4` | "" (UTC) | no | |
| 12 | `led_heartbeat_disabled` | bool | | false | no | |
| 13 | `buzzer_mode` | `BuzzerMode` | `ALL_ENABLED 0, DISABLED 1, NOTIFICATIONS_ONLY 2, SYSTEM_ONLY 3, DIRECT_MSG_ONLY 4` | 0 | no | |

`Role`: `CLIENT 0, CLIENT_MUTE 1, ROUTER 2, ROUTER_CLIENT 3 (deprecated → CLIENT), REPEATER 4
(deprecated 2.7.11 → CLIENT), TRACKER 5, SENSOR 6, TAK 7, CLIENT_HIDDEN 8, LOST_AND_FOUND 9,
TAK_TRACKER 10, ROUTER_LATE 11, CLIENT_BASE 12`. Event firmware (`USERPREFS_EVENT_MODE`) turns
ROUTER/ROUTER_LATE into CLIENT.

`RebroadcastMode`: `ALL 0, ALL_SKIP_DECODING 1 (REPEATER only, else = ALL), LOCAL_ONLY 2,
KNOWN_ONLY 3, NONE 4 (SENSOR/TRACKER/TAK_TRACKER; refused for routers), CORE_PORTNUMS_ONLY 5
(only NodeInfo/Text/Position/Telemetry/Routing)`.

#### 3.1.1 Role defaults written on role change (`NodeDB::installRoleDefaults`, 2.7.26)

| Role | Changes |
|---|---|
| ROUTER | position/power/display intervals reset to router values (§3.2–3.5), telemetry intervals reset, `device_update_interval = 43200`, `rebroadcast_mode = CORE_PORTNUMS_ONLY`, `is_unmessagable = true` |
| ROUTER_LATE | `device_update_interval = 86400`, `is_unmessagable = true` |
| SENSOR | `is_unmessagable = true`, `device_update_interval = 3600`, `environment_measurement_enabled = true`, `environment_update_interval = 300` |
| LOST_AND_FOUND | smart position off, `position_broadcast_secs = 300` |
| TAK | `node_info_broadcast_secs = 86400`, smart position off, `position_broadcast_secs = 86400`, `position_flags = ALTITUDE\|SPEED\|HEADING\|DOP`, `device_update_interval = 86400` |
| TRACKER | `is_unmessagable = true`, `device_update_interval = 3600` |
| TAK_TRACKER | `is_unmessagable = true`, `node_info_broadcast_secs = 86400`, smart position on, `position_broadcast_secs = 180`, smart distance 20 m, smart interval 15 s, `position_flags = ALTITUDE\|SPEED\|HEADING\|DOP`, `device_update_interval = 86400` |
| CLIENT_HIDDEN | `rebroadcast_mode = LOCAL_ONLY`; node info, position, neighbour info and all telemetry intervals = `INT32_MAX` (never) |

"3600" etc. above come from `default_telemetry_broadcast_interval_secs` (3600, or 43200 on
routers). Re-read config and owner after a role change.

### 3.2 PositionConfig (`Config.position = 2`)

| # | Field | Type | Units | Default | Reboot | Notes |
|---|---|---|---|---|---|---|
| 1 | `position_broadcast_secs` | uint32 | s | 3600 (43200 router); 0 → same | yes | Scaled up when > 40 nodes online. Min 3600 on default channel (boot coercion). |
| 2 | `position_broadcast_smart_enabled` | bool | | true | yes | |
| 3 | `fixed_position` | bool | | false | yes | Prefer `set_fixed_position (41)` / `remove_fixed_position (42)`; those do not reboot. |
| 4 | `gps_enabled` | bool | | — | | Deprecated → `gps_mode`. |
| 5 | `gps_update_interval` | uint32 | s | 120 (86400 router); 0 → default; `INT32_MAX`-ish = once at boot | yes | |
| 6 | `gps_attempt_time` | uint32 | | — | | Deprecated. |
| 7 | `position_flags` | uint32 | bitmask `PositionFlags` | `0x32B` = ALTITUDE\|ALTITUDE_MSL\|DOP\|SATINVIEW\|HEADING\|SPEED | yes | |
| 8 | `rx_gpio` | uint32 | GPIO | 0 = board | yes | |
| 9 | `tx_gpio` | uint32 | GPIO | 0 = board | yes | |
| 10 | `broadcast_smart_minimum_distance` | uint32 | m | 100 | yes | |
| 11 | `broadcast_smart_minimum_interval_secs` | uint32 | s | 300 | yes | Min 300 on default channel. |
| 12 | `gps_en_gpio` | uint32 | GPIO | board `PIN_GPS_EN` | yes | |
| 13 | `gps_mode` | `GpsMode` | `DISABLED 0, ENABLED 1, NOT_PRESENT 2` | board-dependent | yes | Switching off ENABLED without fixed position clears the stored position. |

`PositionFlags` bits: `ALTITUDE 0x1, ALTITUDE_MSL 0x2, GEOIDAL_SEPARATION 0x4, DOP 0x8, HVDOP 0x10,
SATINVIEW 0x20, SEQ_NO 0x40, TIMESTAMP 0x80, HEADING 0x100, SPEED 0x200`.

### 3.3 PowerConfig (`Config.power = 3`)

| # | Field | Type | Units | Default | Reboot | Notes |
|---|---|---|---|---|---|---|
| 1 | `is_power_saving` | bool | | false (board `USE_POWERSAVE`: true) | yes | Trackers/sensors also sleep the radio. |
| 2 | `on_battery_shutdown_after_secs` | uint32 | s | 0 = never | yes | 1–29 → 30. |
| 3 | `adc_multiplier_override` | float | ratio 2–6 | 0 = board | no | |
| 4 | `wait_bluetooth_secs` | uint32 | s | 60 (1 router) | yes | ESP32. |
| 6 | `sds_secs` | uint32 | s | `UINT32_MAX` (86400 router) | yes | Super-deep-sleep. |
| 7 | `ls_secs` | uint32 | s | 300 (86400 router) | yes | ESP32 light sleep. The value sent in `FromRadio.config` is always the role default, not the stored one (`PhoneAPI`). |
| 8 | `min_wake_secs` | uint32 | s | 10 | yes | |
| 9 | `device_battery_ina_address` | uint32 | I²C addr | 0 | yes | |
| 32 | `powermon_enables` | uint64 | bitmask | 0 | no | |

### 3.4 NetworkConfig (`Config.network = 4`) — always reboots

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `wifi_enabled` | bool | false | Disables BLE on ESP32. |
| 3 | `wifi_ssid` | string ≤ 32 | "" | |
| 4 | `wifi_psk` | string ≤ 64 | "" | 2.8: remote reads get `"sekrit"`; writing `"sekrit"` keeps the old value. |
| 5 | `ntp_server` | string ≤ 32 | `meshtastic.pool.ntp.org` | |
| 6 | `eth_enabled` | bool | false | |
| 7 | `address_mode` | `AddressMode` `DHCP 0, STATIC 1` | DHCP | |
| 8 | `ipv4_config` | `IpV4Config {ip 1, gateway 2, subnet 3, dns 4}` (fixed32, little-endian octet order as stored by the firmware — unverified) | — | |
| 9 | `rsyslog_server` | string | "" | `host:port` |
| 10 | `enabled_protocols` | uint32 bitmask `NO_BROADCAST 0, UDP_BROADCAST 1` | 0 | Mesh over UDP multicast. |
| 11 | `ipv6_enabled` | bool | false | |

### 3.5 DisplayConfig (`Config.display = 5`)

| # | Field | Type | Values | Default | Reboot |
|---|---|---|---|---|---|
| 1 | `screen_on_secs` | uint32 | s; 0 = 600; `UINT32_MAX` = always on | 600 (1 router) | yes |
| 2 | `gps_format` | enum | deprecated 2.7.4 (moved to `DeviceUIConfig.gps_format`) | — | — |
| 3 | `auto_screen_carousel_secs` | uint32 | s; 0 = off | 0 | no |
| 4 | `compass_north_top` | bool | deprecated | — | — |
| 5 | `flip_screen` | bool | | board | yes |
| 6 | `units` | `DisplayUnits` `METRIC 0, IMPERIAL 1` | | 0 | no |
| 7 | `oled` | `OledType` `OLED_AUTO 0, OLED_SSD1306 1, OLED_SH1106 2, OLED_SH1107 3, OLED_SH1107_128_128 4, OLED_SH1107_ROTATED 5 (proto ≥ 2.7.26)` | | 0 | yes |
| 8 | `displaymode` | `DisplayMode` `DEFAULT 0, TWOCOLOR 1, INVERTED 2, COLOR 3` | | 0 (TFT boards: COLOR) | yes; →COLOR disables BLE |
| 9 | `heading_bold` | bool | | false | no |
| 10 | `wake_on_tap_or_motion` | bool | | board | no |
| 11 | `compass_orientation` | `CompassOrientation` `DEGREES_0 0 … DEGREES_270 3, DEGREES_0_INVERTED 4 … DEGREES_270_INVERTED 7` | | board | no |
| 12 | `use_12h_clock` | bool | | false | no |
| 13 | `use_long_node_name` | bool | | false | no |
| 14 | `enable_message_bubbles` | bool | proto ≥ 2.7.26 | true on large TFTs | no |

### 3.6 LoRaConfig (`Config.lora = 6`)

| # | Field | Type | Units / values | Default | Reboot 2.7.x | Notes |
|---|---|---|---|---|---|---|
| 1 | `use_preset` | bool | | true | yes | false = use 3/4/5. |
| 2 | `modem_preset` | `ModemPreset` | table below | `LONG_FAST` | yes | |
| 3 | `bandwidth` | uint32 | kHz; special codes 31→31.25, 62→62.5, 200→203.125, 400→406.25, 800→812.5, 1600→1625 | 0 | yes | Only when `use_preset = false`. |
| 4 | `spread_factor` | uint32 | 5–12 (RF95: 7–12) | 0 | yes | Out of range → 11. |
| 5 | `coding_rate` | uint32 | 4/x denominator, 5–8 | 0 | yes | See note on coding rate below. |
| 6 | `frequency_offset` | float | MHz added to centre | 0 | yes | Crystal correction. |
| 7 | `region` | `RegionCode` | table below | `UNSET` | yes | TX disabled while UNSET. |
| 8 | `hop_limit` | uint32 | 0–7 | 3 | no | Values ≥ 7 treated as 7. |
| 9 | `tx_enabled` | bool | | true | no | |
| 10 | `tx_power` | int32 | dBm; 0 = region max | 0 | yes | Values above the region limit are capped unless licensed. After apply, the firmware writes the effective dBm back into this field (RAM), so a read returns e.g. 30 instead of 0. |
| 11 | `channel_num` | uint32 | frequency slot, 1-based; 0 = hash of primary channel name | 0 | yes | §5.5 |
| 12 | `override_duty_cycle` | bool | | false | no | Ignore region duty cycle (ham). |
| 13 | `sx126x_rx_boosted_gain` | bool | | true | yes | |
| 14 | `override_frequency` | float | MHz; 0 = off | 0 | yes | Replaces slot calculation. |
| 15 | `pa_fan_disabled` | bool | | false | no | Boards with `RF95_FAN_EN`. |
| 103 | `ignore_incoming` | repeated uint32 | node nums, max 3 | [] | no | Testing aid: drop packets from these nodes. |
| 104 | `ignore_mqtt` | bool | | false; set true when region with duty cycle < 100 % is first set | no | Drop `via_mqtt` packets. |
| 105 | `config_ok_to_mqtt` | bool | | false | no | Sets `Data.bitfield` OK_TO_MQTT on own packets. |
| 106 | `fem_lna_mode` | `FEM_LNA_Mode` `DISABLED 0, ENABLED 1, NOT_PRESENT 2` | proto ≥ 2.7.26 | board | no | Normalised to NOT_PRESENT if hardware lacks LNA control. |
| 107 | `serial_hal_only` | bool | proto ≥ 2.7.26 | false | (unverified) | Portduino: radio via serial HAL. |

2.8.0: none of the LoRa fields reboot; changes apply live.

**Coding rate with presets.** 2.7.26 `applyModemConfig`: if `use_preset` and `coding_rate` is
5–8 and differs from the preset's CR, the stored value is used (can lower it). Because
`set_config` turns `coding_rate = 0` into 5, writing a LONG_SLOW/LONG_MODERATE/LONG_TURBO (CR 8)
config with `coding_rate = 0` on 2.7.26 makes the node run CR 4/5. Recommended for 2.7.x: send the
preset's own CR (table below). 2.8.0: the stored value is only used if it is **higher** than the
preset's CR, so 0/5 are harmless. CR is in the explicit LoRa header, so mismatched CR still
interoperates.

#### ModemPreset

| Value | Name | BW kHz (2.4 GHz) | SF | CR 4/x | Display / default channel name | In proto | Firmware runs it |
|---|---|---|---|---|---|---|---|
| 0 | LONG_FAST | 250 (812.5) | 11 | 5 | LongFast | all | all |
| 1 | LONG_SLOW | 125 (406.25) | 12 | 8 | LongSlow | all (deprecated 2.7) | all |
| 2 | VERY_LONG_SLOW | — | — | — | "Invalid" | all (deprecated 2.5) | no — falls back to LONG_FAST params |
| 3 | MEDIUM_SLOW | 250 (812.5) | 10 | 5 | MediumSlow | all | all |
| 4 | MEDIUM_FAST | 250 (812.5) | 9 | 5 | MediumFast | all | all |
| 5 | SHORT_SLOW | 250 (812.5) | 8 | 5 | ShortSlow | all | all |
| 6 | SHORT_FAST | 250 (812.5) | 7 | 5 | ShortFast | all | all |
| 7 | LONG_MODERATE | 125 (406.25) | 11 | 8 | LongMod | all | all |
| 8 | SHORT_TURBO | 500 (1625) | 7 | 5 | ShortTurbo | all | all |
| 9 | LONG_TURBO | 500 (1625) | 11 | 8 | LongTurbo | ≥ 2.7.26 | ≥ 2.7.26 |
| 10 | LITE_FAST | 125 | 9 | 5 | LiteFast | ≥ 2.7.26 | 2.8 (2.7.26: LONG_FAST params, name "Invalid") |
| 11 | LITE_SLOW | 125 | 10 | 5 | LiteSlow | ≥ 2.7.26 | 2.8 |
| 12 | NARROW_FAST | 62.5 | 7 | 6 | NarrowFast | ≥ 2.7.26 | 2.8 |
| 13 | NARROW_SLOW | 62.5 | 8 | 6 | NarrowSlow | ≥ 2.7.26 | 2.8 |
| 14 | TINY_FAST | 15.6 | 7 | 5 | TinyFast | ≥ 2.8.0 | 2.8 |
| 15 | TINY_SLOW | 15.6 | 8 | 6 | TinySlow | ≥ 2.8.0 | 2.8 |
| 16 | MEDIUM_TURBO | 500 (1625) | 9 | 5 | MediumTurbo | ≥ 2.8.0 | 2.8 |

Source: `modemPresetToParams` (`src/mesh/MeshRadio.h`), `DisplayFormatters::getModemPresetDisplayName`.
The display name is also the implicit primary channel name and the frequency-slot hash input, so a
preset the firmware does not know hashes as `"Invalid"` (or `"Custom"` when `use_preset = false`).

**`modem_preset = 120`.** Not a defined value in any protobufs version (2.7.15 through master) nor
in firmware `v2.8.0` / `v2.8.1` / `develop` (`_meshtastic_Config_LoRaConfig_ModemPreset_MAX =
MEDIUM_TURBO = 16`). Firmware treats unknown values as LONG_FAST (`default:` branch) and names
them "Invalid". Observed on a 2.8.0.4f0be0e build (raw `Config.lora` bytes `08 01 10 78 ...`: field 2 =
120, `use_preset = true`); the same build string is used by a third-party fork, so 120 is most likely a
fork-specific preset. A client should render out-of-range presets as "unknown (N)".

2.8 also restricts which presets are legal per region (`RegionProfile`): standard regions allow
LONG_FAST, LONG_SLOW, MEDIUM_SLOW, MEDIUM_FAST, SHORT_SLOW, SHORT_FAST, LONG_MODERATE,
SHORT_TURBO, LONG_TURBO, MEDIUM_TURBO; EU_868 allows the first seven only; EU_866 → LITE_*;
EU_N_868 → NARROW_*; ham 2 m → TINY_*; ham 70 cm / 1.25 m → NARROW_*. The node advertises this
in `FromRadio.region_presets`.

#### RegionCode and firmware region table

Proto values: `UNSET 0, US 1, EU_433 2, EU_868 3, CN 4, JP 5, ANZ 6, KR 7, TW 8, RU 9, IN 10,
NZ_865 11, TH 12, LORA_24 13, UA_433 14, UA_868 15 (deprecated 2.8), MY_433 16, MY_919 17,
SG_923 18, PH_433 19, PH_868 20, PH_915 21, ANZ_433 22, KZ_433 23, KZ_863 24, NP_865 25,
BR_902 26` (all versions); `ITU1_2M 27, ITU2_2M 28, EU_866 29, EU_874 30, EU_917 31,
EU_N_868 32, ITU3_2M 33` (proto ≥ 2.7.26); `ITU1_70CM 34, ITU2_70CM 35, ITU3_70CM 36,
ITU2_125CM 37` (proto ≥ 2.8.0).

Firmware 2.7.26 region table (`RDEF` in `RadioInterface.cpp`; spacing 0 for all; start/end MHz,
duty cycle %, power limit dBm):

| Region | Start | End | Duty % | Max dBm | Note |
|---|---|---|---|---|---|
| US | 902.0 | 928.0 | 100 | 30 | |
| EU_433 | 433.0 | 434.0 | 10 | 10 | |
| EU_868 | 869.4 | 869.65 | 10 | 27 | one 250 kHz slot |
| CN | 470.0 | 510.0 | 100 | 19 | |
| JP | 920.5 | 923.5 | 100 | 13 | |
| ANZ | 915.0 | 928.0 | 100 | 30 | |
| ANZ_433 | 433.05 | 434.79 | 100 | 14 | |
| RU | 868.7 | 869.2 | 100 | 20 | |
| KR | 920.0 | 923.0 | 100 | 23 | |
| TW | 920.0 | 925.0 | 100 | 27 | |
| IN | 865.0 | 867.0 | 100 | 30 | |
| NZ_865 | 864.0 | 868.0 | 100 | 36 | |
| TH | 920.0 | 925.0 | 10 | 27 | |
| UA_433 | 433.0 | 434.7 | 10 | 10 | |
| UA_868 | 868.0 | 868.6 | 1 | 14 | removed in 2.8 table |
| MY_433 | 433.0 | 435.0 | 100 | 20 | |
| MY_919 | 919.0 | 924.0 | 100 | 27 | frequency switching |
| SG_923 | 917.0 | 925.0 | 100 | 20 | |
| PH_433 / PH_868 / PH_915 | 433.0–434.7 / 868.0–869.4 / 915.0–918.0 | | 100 | 10 / 14 / 24 | |
| KZ_433 / KZ_863 | 433.075–434.775 / 863.0–868.0 | | 100 | 10 / 30 | |
| NP_865 | 865.0 | 868.0 | 100 | 30 | |
| BR_902 | 902.0 | 907.5 | 100 | 30 | |
| LORA_24 | 2400.0 | 2483.5 | 100 | 10 | wide LoRa (BW column in brackets) |
| UNSET | 902.0 | 928.0 | 100 | 30 | TX off |

2.7.26 has **no firmware entries** for ITU*, EU_866, EU_874, EU_917, EU_N_868 even though its proto
lists some of them (unverified fallback: `getRegion` returns the UNSET entry for unknown codes).
2.8.0 adds: `EU_866 865.6–867.6 MHz, 2.5 %, 27 dBm, LITE profile (spacing 0.4 MHz, padding
0.0375 MHz), default LITE_FAST`; `EU_N_868 869.4–869.65, 10 %, 27 dBm, NARROW profile (padding
0.0104), default NARROW_SLOW, override slot 1`; ham bands `ITU1_2M 144–146, ITU2_2M 144–148,
ITU3_2M 144–148 (TINY, override slots 26/51/33), ITU2_125CM 220–225, ITU1_70CM 430–440,
ITU2_70CM 420–450, ITU3_70CM 430–450 (NARROW 100 kHz raster, override slots 37/37/137/37)`, all
30 dBm. EU_874/EU_917 have no table entry in 2.8.0.

### 3.7 BluetoothConfig (`Config.bluetooth = 7`) — always reboots

| # | Field | Type | Values | Default |
|---|---|---|---|---|
| 1 | `enabled` | bool | | true (some TFT boards false) |
| 2 | `mode` | `PairingMode` `RANDOM_PIN 0, FIXED_PIN 1, NO_PIN 2` | | RANDOM_PIN with screen, else FIXED_PIN |
| 3 | `fixed_pin` | uint32 | 6 digits | 123456 |

2.8 hardened builds redact `fixed_pin` to unauthenticated clients.

### 3.8 SecurityConfig (`Config.security = 8`)

| # | Field | Type | Default | Reboot | Notes |
|---|---|---|---|---|---|
| 1 | `public_key` | bytes(32) | generated when region first set | 2.7.x no / 2.8 yes | Derived from private key; client value ignored on write. |
| 2 | `private_key` | bytes(32) | generated | same | 2.8: stripped from remote `get_config` responses. Writing a new 32-byte key rotates identity (2.8: node number changes to CRC32 of new public key). Writing empty: 2.7.x regenerates; 2.8 keeps the old pair. |
| 3 | `admin_key` | repeated bytes(32), max 3 | [] | same | 2.8: a write that only rotates the keypair keeps existing admin keys. |
| 4 | `is_managed` | bool | false | same | Requires ≥ 1 admin key. Blocks local admin. |
| 5 | `serial_enabled` | bool | true | same | false disables the serial stream API — **a serial-only client locks itself out**. |
| 6 | `debug_log_api_enabled` | bool | false | same | true = `LogRecord`s keep flowing to API clients. |
| 8 | `admin_channel_enabled` | bool | false | same | Legacy `admin` channel. |
| 9 | `packet_signature_policy` | `PacketSignaturePolicy` `COMPATIBLE 0, BALANCED 1, STRICT 2` | 0 | 2.8 yes | proto ≥ 2.8.0. XEdDSA receive policy. Builds without XEdDSA force 0 with a warning. |

Reboot column: 2.7.x never reboots on security writes (see §2.3); 2.8 always reboots.

### 3.9 SessionkeyConfig (`Config.sessionkey = 9`)

Empty message. Only use: `get_config_request = SESSIONKEY_CONFIG (8)` to obtain a
`session_passkey` (advanced-features.md §5.2).

### 3.10 DeviceUIConfig (`Config.device_ui = 10`)

Persisted UI state for on-device TFT UIs (MUI/BaseUI). Read with `get_ui_config_request (44)`
→ `get_ui_config_response (45)`; write with `store_ui_config (46)` (no reboot). Also sent as
`FromRadio.deviceuiConfig (17)` during want_config when present. Writing via `set_config` is a
no-op that still reboots.

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | `version` | uint32 | |
| 2 | `screen_brightness` | uint32 | 1–255 |
| 3 | `screen_timeout` | uint32 | s, 0–900 |
| 4 | `screen_lock` | bool | |
| 5 | `settings_lock` | bool | |
| 6 | `pin_code` | uint32 | |
| 7 | `theme` | `Theme` `DARK 0, LIGHT 1, RED 2` | |
| 8 | `alert_enabled` | bool | |
| 9 | `banner_enabled` | bool | |
| 10 | `ring_tone_id` | uint32 | |
| 11 | `language` | `Language` `ENGLISH 0 … AZERBAIJANI 21, SIMPLIFIED_CHINESE 30, TRADITIONAL_CHINESE 31` | HUNGARIAN 20, AZERBAIJANI 21 added after 2.7.15 |
| 12 | `node_filter` | `NodeFilter {unknown_switch 1, offline_switch 2, public_key_switch 3, hops_away 4 int32, position_switch 5, node_name 6, channel 7 int32}` | |
| 13 | `node_highlight` | `NodeHighlight {chat_switch 1, position_switch 2, telemetry_switch 3, iaq_switch 4, node_name 5}` | |
| 14 | `calibration_data` | bytes | 8 ints |
| 15 | `map_data` | `Map {home 1 GeoPoint{zoom 1, latitude 2, longitude 3}, style 2, follow_gps 3}` | |
| 16 | `compass_mode` | `CompassMode` `DYNAMIC 0, FIXED_RING 1, FREEZE_HEADING 2` | |
| 17 | `screen_rgb_color` | uint32 | 0xRRGGBB |
| 18 | `is_clockface_analog` | bool | |
| 19 | `gps_format` | `GpsCoordinateFormat` `DEC 0, DMS 1, UTM 2, MGRS 3, OLC 4, OSGR 5, MLS 6` | |

---

## 4. ModuleConfig sections

All module writes reboot except where noted (§2.3). A module whose `enabled` flag is false is
usually **not instantiated** (no request handling) until reboot.

### 4.1 MQTTConfig (`mqtt = 1`)

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `enabled` | bool | false | |
| 2 | `address` | string ≤ 63 | `mqtt.meshtastic.org` | `host[:port]` |
| 3 | `username` | string ≤ 63 | `meshdev` | Public-server default credential (published in firmware). |
| 4 | `password` | string ≤ 31 | `large4cats` | idem; 2.8: write `"sekrit"` to keep. |
| 5 | `encryption_enabled` | bool | true | Publish encrypted envelopes. |
| 6 | `json_enabled` | bool | false | Deprecated in proto ≥ 2.7.26, ignored. |
| 7 | `tls_enabled` | bool | false | Refused (`BAD_REQUEST`) on builds without TLS. |
| 8 | `root` | string ≤ 31 | `msh` → `msh/<REGION>` once region set | |
| 9 | `proxy_to_client_enabled` | bool | false | Node sends `FromRadio.mqttClientProxyMessage (14)`; client publishes and returns `ToRadio.mqttClientProxyMessage (6)`. Required on nodes without network. |
| 10 | `map_reporting_enabled` | bool | false | `MAP_REPORT_APP` to MQTT. |
| 11 | `map_report_settings` | `MapReportSettings {publish_interval_secs 1 (default 3600), position_precision 2 (12–15 else 14), should_report_location 3}` | | |

Validation (`MQTT::isValidConfig`): with `enabled` and not proxy mode, the node tries a TCP connect
when it has network and warns (ClientNotification) if unreachable but still saves; without
networking hardware, proxy mode is required (`BAD_REQUEST`). MQTT writes do not disable BLE before
validation.

### 4.2 SerialConfig (`serial = 2`)

| # | Field | Type | Values | Default |
|---|---|---|---|---|
| 1 | `enabled` | bool | | false |
| 2 | `echo` | bool | | false |
| 3 | `rxd` | uint32 | GPIO | 0 |
| 4 | `txd` | uint32 | GPIO | 0 |
| 5 | `baud` | `Serial_Baud` | `BAUD_DEFAULT 0, 110 1, 300 2, 600 3, 1200 4, 2400 5, 4800 6, 9600 7, 19200 8, 38400 9, 57600 10, 115200 11, 230400 12, 460800 13, 576000 14, 921600 15` | 0 |
| 6 | `timeout` | uint32 | ms | 0 |
| 7 | `mode` | `Serial_Mode` | `DEFAULT 0, SIMPLE 1, PROTO 2, TEXTMSG 3, NMEA 4, CALTOPO 5, WS85 6, VE_DIRECT 7, MS_CONFIG 8, LOG 9 (proto ≥ 2.7.26), LOGTEXT 10 (≥ 2.7.26), MODBUS 11 (master)` | 0 |
| 8 | `override_console_serial_port` | bool | only valid with NMEA/CALTOPO/MS_CONFIG, else `BAD_REQUEST` | false |

Module not started on ESP32-S2/C3 or when `display.displaymode = COLOR`.

### 4.3 ExternalNotificationConfig (`external_notification = 3`)

| # | Field | Type | Default (typical) | Notes |
|---|---|---|---|---|
| 1 | `enabled` | bool | true on boards with buzzer/vibra/notification LED | |
| 2 | `output_ms` | uint32 ms | 1000 (500 vibra, board) | |
| 3 | `output` | uint32 GPIO | board LED | |
| 8 | `output_vibra` | uint32 GPIO | board | |
| 9 | `output_buzzer` | uint32 GPIO | board buzzer | |
| 4 | `active` | bool | board | output active-high |
| 5 | `alert_message` | bool | board | |
| 10 | `alert_message_vibra` | bool | board | |
| 11 | `alert_message_buzzer` | bool | true with buzzer | |
| 6 | `alert_bell` | bool | false | on BEL (0x07) |
| 12 | `alert_bell_vibra` | bool | false | |
| 13 | `alert_bell_buzzer` | bool | false | |
| 7 | `use_pwm` | bool | true with PWM buzzer | uses `device.buzzer_gpio` |
| 14 | `nag_timeout` | uint32 s | 15 (2 with vibra, 0 on TFT) | 0 = no repeat |
| 15 | `use_i2s_as_buzzer` | bool | true on I²S boards | |

Ringtone: `set_ringtone_message (37)` / `get_ringtone_request (14)`, RTTTL ≤ 230 bytes.

### 4.4 StoreForwardConfig (`store_forward = 4`)

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `enabled` | bool | false | ESP32/Portduino only. |
| 2 | `heartbeat` | bool | false | Server broadcasts ROUTER_HEARTBEAT every 900 s. |
| 3 | `records` | uint32 | 0 = ¾ of free PSRAM | |
| 4 | `history_return_max` | uint32 | 0 → 25 | |
| 5 | `history_return_window` | uint32 | 0 → 240 | minutes |
| 6 | `is_server` | bool | false | Also implied by ROUTER/ROUTER_LATE role. Needs PSRAM ≥ 1 MiB free. |

### 4.5 RangeTestConfig (`range_test = 5`)

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `enabled` | bool | false | |
| 2 | `sender` | uint32 s | 0 = receiver | Send interval; sender stops after 8 h. |
| 3 | `save` | bool | false | CSV on flash, ESP32. |
| 4 | `clear_on_reboot` | bool | false | proto ≥ 2.7.15 |

### 4.6 TelemetryConfig (`telemetry = 6`)

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `device_update_interval` | uint32 s | `INT32_MAX` (factory) → effectively never; 0 → 3600 (43200 router) | Min 1800 (43200 router) on default channel. |
| 2 | `environment_update_interval` | uint32 s | 0 → 3600 | |
| 3 | `environment_measurement_enabled` | bool | false (SENSOR role: true) | Creates EnvironmentTelemetryModule. |
| 4 | `environment_screen_enabled` | bool | false | |
| 5 | `environment_display_fahrenheit` | bool | false | |
| 6 | `air_quality_enabled` | bool | false | |
| 7 | `air_quality_interval` | uint32 s | 0 → 3600 | |
| 8 | `power_measurement_enabled` | bool | false | |
| 9 | `power_update_interval` | uint32 s | 0 → 3600 | |
| 10 | `power_screen_enabled` | bool | false | |
| 11 | `health_measurement_enabled` | bool | false | |
| 12 | `health_update_interval` | uint32 s | 0 → 3600 | |
| 13 | `health_screen_enabled` | bool | false | |
| 14 | `device_telemetry_enabled` | bool | false | Broadcast device metrics to the mesh; client still gets them ~1/min. |
| 15 | `air_quality_screen_enabled` | bool | false | proto ≥ 2.7.26 |

Intervals scale with mesh size (> 40 online nodes) except for SENSOR/TRACKER/TAK_TRACKER and
routers.

### 4.7 CannedMessageConfig (`canned_message = 7`)

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | `rotary1_enabled` | bool | |
| 2 | `inputbroker_pin_a` | uint32 | |
| 3 | `inputbroker_pin_b` | uint32 | |
| 4 | `inputbroker_pin_press` | uint32 | |
| 5 | `inputbroker_event_cw` | `InputEventChar` | `NONE 0, UP 17, DOWN 18, LEFT 19, RIGHT 20, SELECT 10, BACK 27, CANCEL 24` |
| 6 | `inputbroker_event_ccw` | `InputEventChar` | |
| 7 | `inputbroker_event_press` | `InputEventChar` | |
| 8 | `updown1_enabled` | bool | |
| 9 | `enabled` | bool | deprecated |
| 10 | `allow_input_source` | string | deprecated |
| 11 | `send_bell` | bool | append BEL |

Message list itself: `set_canned_message_module_messages (36)` (advanced-features.md §12).

### 4.8 AudioConfig (`audio = 8`)

ESP32 + SX1280 only (2.4 GHz).

| # | Field | Type | Values |
|---|---|---|---|
| 1 | `codec2_enabled` | bool | |
| 2 | `ptt_pin` | uint32 | |
| 3 | `bitrate` | `Audio_Baud` | `CODEC2_DEFAULT 0, 3200 1, 2400 2, 1600 3, 1400 4, 1300 5, 1200 6, 700 7 (deprecated master), 700B 8 (deprecated master), 700C 9 (master), 450 10 (master)` |
| 4 | `i2s_ws` | uint32 | |
| 5 | `i2s_sd` | uint32 | |
| 6 | `i2s_din` | uint32 | |
| 7 | `i2s_sck` | uint32 | |

### 4.9 RemoteHardwareConfig (`remote_hardware = 9`)

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | `enabled` | bool | |
| 2 | `allow_undefined_pin_access` | bool | |
| 3 | `available_pins` | repeated `RemoteHardwarePin {gpio_pin 1, name 2, type 3 (UNKNOWN 0, DIGITAL_READ 1, DIGITAL_WRITE 2)}`, max 4 | |

Port `REMOTE_HARDWARE_APP = 2`, payload `HardwareMessage` (remote_hardware.proto).

### 4.10 NeighborInfoConfig (`neighbor_info = 10`)

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `enabled` | bool | false | |
| 2 | `update_interval` | uint32 s | 0 → 21600 | < 14400 → 21600 |
| 3 | `transmit_over_lora` | bool | false | Never over LoRa on the default channel/slot. |

### 4.11 AmbientLightingConfig (`ambient_lighting = 11`)

| # | Field | Type | Default |
|---|---|---|---|
| 1 | `led_state` | bool | false |
| 2 | `current` | uint32 | 10 |
| 3 | `red` | uint32 0–255 | from node num bits 16–23 |
| 4 | `green` | uint32 0–255 | node num bits 8–15 |
| 5 | `blue` | uint32 0–255 | node num bits 0–7 |

### 4.12 DetectionSensorConfig (`detection_sensor = 12`)

| # | Field | Type | Default | Notes |
|---|---|---|---|---|
| 1 | `enabled` | bool | false | |
| 2 | `minimum_broadcast_secs` | uint32 s | 45 | |
| 3 | `state_broadcast_secs` | uint32 s | 0 = off | |
| 4 | `send_bell` | bool | false | |
| 5 | `name` | string ≤ 19 | "" | Message `"<name> detected"`. |
| 6 | `monitor_pin` | uint32 | 0 | |
| 7 | `detection_trigger_type` | `TriggerType` | `LOGIC_HIGH` | `LOGIC_LOW 0, LOGIC_HIGH 1, FALLING_EDGE 2, RISING_EDGE 3, EITHER_EDGE_ACTIVE_LOW 4, EITHER_EDGE_ACTIVE_HIGH 5` |
| 8 | `use_pullup` | bool | false | |

### 4.13 PaxcounterConfig (`paxcounter = 13`)

| # | Field | Type | Default |
|---|---|---|---|
| 1 | `enabled` | bool | false |
| 2 | `paxcounter_update_interval` | uint32 s | 0 → 3600 |
| 3 | `wifi_threshold` | int32 dBm | 0 → −80 (per proto comment) |
| 4 | `ble_threshold` | int32 dBm | 0 → −80 |

### 4.14 StatusMessageConfig (`statusmessage = 14`, proto ≥ 2.7.26)

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | `node_status` | string ≤ 79 | Non-empty → broadcast `StatusMessage{status 1}` on `NODE_STATUS_APP (36)` every 12 h (and at module start). No reboot on write. |

### 4.15 TrafficManagementConfig (`traffic_management = 15`)

Field layout differs between versions; 2.7.26 firmware has the proto but no module.

2.7.26 proto: `enabled 1, position_dedup_enabled 2, position_precision_bits 3,
position_min_interval_secs 4, nodeinfo_direct_response 5, nodeinfo_direct_response_max_hops 6,
rate_limit_enabled 7, rate_limit_window_secs 8, rate_limit_max_packets 9, drop_unknown_enabled 10,
unknown_packet_threshold 11, exhaust_hop_telemetry 12, exhaust_hop_position 13,
router_preserve_hops 14`.

2.8.0 proto (fields 1, 2, 3, 5, 7, 10, 12, 13, 14 **reserved**; "0 = disabled", no firmware-default
sentinel):

| # | Field | Type | 2.8 factory default |
|---|---|---|---|
| 4 | `position_min_interval_secs` | uint32 s | 18000 (identical-position dedup window) |
| 6 | `nodeinfo_direct_response_max_hops` | uint32 | 0 (off) |
| 8 | `rate_limit_window_secs` | uint32 s | 0 (off) |
| 9 | `rate_limit_max_packets` | uint32 | 0 (off) |
| 11 | `unknown_packet_threshold` | uint32 per 5 min | 0 (off) |

Defaults from `installTrafficManagementDefaults` (`src/mesh/NodeDB.cpp`, 2.8.0): only position
dedup is on.

Module active in 2.8 builds except tiny MCUs (`HAS_TRAFFIC_MANAGEMENT`). Effect visible to a
client: duplicate positions from other nodes may be dropped by relays, NodeInfo requests may be
answered from a relay's cache. Stats in `Telemetry.traffic_management_stats (9)`.

### 4.16 TAKConfig (`tak = 16`, proto ≥ 2.7.26)

| # | Field | Type | Default |
|---|---|---|---|
| 1 | `team` | `Team` (atak.proto) | 0 → Cyan |
| 2 | `role` | `MemberRole` (atak.proto) | 0 → TeamMember |

### 4.17 MeshBeaconConfig (`mesh_beacon = 17`, proto ≥ 2.8.0) — no reboot

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | `flags` | uint32 | `FLAG_LISTEN_ENABLED 1, FLAG_BROADCAST_ENABLED 2, FLAG_LEGACY_SPLIT 4` |
| 2 | `broadcast_offer_frequency_slot` | optional uint32 | master only |
| 4 | `broadcast_message` | string | firmware caps at 100 chars (master proto: 60 bytes) |
| 5 | `broadcast_offer_channel` | `ChannelSettings` | |
| 6 | `broadcast_offer_region` | `RegionCode` | |
| 7 | `broadcast_offer_preset` | optional `ModemPreset` | cleared if invalid for region |
| 11 | `broadcast_interval_secs` | uint32 | min/default 3600 |
| 13 | `broadcast_targets` | repeated `BroadcastTarget {preset 1 optional, region 2, channel_index 4 optional, frequency_slot 5 optional (master)}` | |

Reserved: 3, 8, 9, 10. Port `MESH_BEACON_APP = 37`.

---

## 5. Channels

### 5.1 Messages

`Channel`: `index (1) int32` 0–7, `settings (2) ChannelSettings`, `role (3) Role`
(`DISABLED 0, PRIMARY 1, SECONDARY 2`).

`ChannelSettings`:

| # | Field | Type | Notes |
|---|---|---|---|
| 1 | `channel_num` | uint32 | Deprecated (use `LoRaConfig.channel_num`). |
| 2 | `psk` | bytes ≤ 32 | §5.2 |
| 3 | `name` | string ≤ 11 bytes | "" = use preset display name. `"Default"` is rewritten to "" by the firmware. Names `admin`, `serial`, `gpio`, `mqtt` are special. |
| 4 | `id` | fixed32 | Random id for global channel id; not used for routing. |
| 5 | `uplink_enabled` | bool | MQTT uplink. |
| 6 | `downlink_enabled` | bool | MQTT downlink. |
| 7 | `module_settings` | `ModuleSettings` | |
| 8 | `use_aead` | bool | protobufs master only (AES-CCM channel encryption, experimental); not in 2.8.0. |

`ModuleSettings`: `position_precision (1) uint32` (bits, see advanced-features.md §7.2),
`is_muted (2) bool` (client-side mute hint).

Rules (`Channels::setChannel`, `fixupChannel`, `AdminModule::handleSetChannel`):
- `set_channel` with index outside 0–7 → `BAD_REQUEST`.
- Writing role PRIMARY demotes the previous primary to SECONDARY. Exactly one primary is expected;
  the radio frequency/preset follows the primary.
- A channel written without `settings` becomes DISABLED.
- Licensed owner (`is_licensed`): all PSKs are cleared on every write and the `admin` channel
  disabled (`ensureLicensedOperation`).
- 2.8: on `set_channel`, `position_precision` of affected channels is clamped (public-key
  channels ≤ 15) and a warning sent.
- No reboot. Disabling/renaming the primary changes the channel hash and (if `channel_num = 0`)
  the frequency slot immediately.

Factory channel 0: `role PRIMARY, psk = [0x01], name = ""`, `module_settings.position_precision`
= **13 in 2.7.x, 0 in 2.8** (location sharing is opt-in in 2.8). Channels 1–7: DISABLED.

2.8 one-time upgrade migration (`NodeDB` load, gated on `POSITION_TELEMETRY_OPTIN_VER`): on every
channel whose effective key is public (no PSK / 1-byte PSK) `position_precision` is set to 0, and
in module config `telemetry.device_telemetry_enabled`, `environment_measurement_enabled`,
`air_quality_enabled`, `power_measurement_enabled`, `health_measurement_enabled` and
`mqtt.map_report_settings.should_report_location` are set to false. A 2.7 node upgraded to 2.8
therefore stops broadcasting position and telemetry until re-enabled.

### 5.2 PSK semantics (`Channels::getKey`)

| `psk` length | Meaning |
|---|---|
| 0 | PRIMARY: no encryption. SECONDARY: use the primary channel's key. |
| 1, value 0 | No encryption. |
| 1, value 1 | Default key `d4 f1 bb 3a 20 29 07 59 f0 bc ff ab cf 4e 69 01` (AES-128, public). |
| 1, value n = 2…255 | Default key with last byte + (n − 1) (uint8 wrap). Apps label 1–10 "simple0…simple9"/"default+N" (naming unverified). |
| 2–15 | Zero-padded to 16 bytes, AES-128 (warning logged). |
| 16 | AES-128-CTR. |
| 17–31 | Zero-padded to 32 bytes, AES-256. |
| 32 | AES-256-CTR. |

Channel encryption = AES-CTR, nonce = packet id (64-bit LE) ‖ from node (32-bit LE) ‖ zeros,
4-byte counter (`CryptoEngine::initNonce`, `encryptAESCtr`). No authentication tag.

"Default channel" (`Channels::isDefaultChannel`): `psk == [0x01]` and the effective name equals the
preset display name. Several features refuse to work on it (S&F, detection sensor, neighbour info
over LoRa) and minimum intervals are enforced (§2.4).

### 5.3 Effective channel name

`Channels::getName(i)`: `settings.name` if non-empty, else `getModemPresetDisplayName(preset)`
(`"LongFast"`, `"MediumFast"`, … table in §3.6), or `"Custom"` when `use_preset = false`.
Unknown presets yield `"Invalid"`.

### 5.4 Channel hash (on-air `channel` byte)

```
hash(i) = xor(bytes of getName(i)) XOR xor(bytes of expanded key)
```
`expanded key` = result of §5.2 (0 bytes when unencrypted; primary key for an empty secondary).
Disabled channels have no hash. Example: name `"LongFast"` + default key → `0x08`;
`"MediumFast"` + default key → `0x1F`. Receivers try every channel whose hash matches. PKC packets
use hash 0.

### 5.5 Frequency slot (`RadioInterface::applyModemConfig`)

`bw` = preset bandwidth in kHz (§3.6; wide values on LORA_24) or `bwCodeToKHz(lora.bandwidth)`.
`name` = effective name of the **primary** channel (§5.3). `djb2(s)`: `h = 5381; for c: h = h*33 + c`
(uint32).

**2.7.x**
```
numSlots = floor((freqEnd − freqStart) / (spacing + bw/1000))          // spacing = 0 in all 2.7 regions
slot     = lora.channel_num ? (lora.channel_num − 1) % numSlots : djb2(name) % numSlots   // 0-based
freqMHz  = freqStart + bw/2000 + slot × bw/1000
if override_frequency: freqMHz = override_frequency
freqMHz += frequency_offset
uses_default_frequency_slot = (slot == djb2(presetDisplayName) % numSlots)
```

**2.8.0**
```
slotWidth = spacing + 2×padding + bw/1000                      // region profile (§3.6)
numSlots  = round((freqEnd − freqStart + spacing) / slotWidth)
default   = overrideSlot > 0 ? overrideSlot − 1
          : overrideSlot == −1 ? djb2(presetDisplayName) % numSlots
          : djb2(name) % numSlots
slot      = (channel_num == 0 or channel_num equals the default) ? default : channel_num − 1
freqMHz   = freqStart + bw/2000 + padding + slot × slotWidth
```
2.8 rejects/clamps `channel_num > numSlots` (error notification "Channel number N invalid for
REGION, max is M"); 2.7 wraps it with modulo.

Examples (default key irrelevant here): US, LONG_FAST, name "" → `"LongFast"`, 104 slots,
slot 20 (1-based), 906.875 MHz. US, MEDIUM_FAST → slot 45, 913.125 MHz. EU_868, LONG_FAST → 1 slot,
869.525 MHz.

Consequences for a UI: renaming the primary channel moves the radio to another frequency unless
`channel_num` is pinned; two meshes with the same preset but different primary names generally
cannot hear each other.

---

## 6. Owner (User) settings

Written with `AdminMessage.set_owner (32)`; read via `get_owner_request (3)` or the own
`NodeInfo.user` at connect.

| # | Field | Type | Settable | Notes |
|---|---|---|---|---|
| 1 | `id` | string | no | Forced to `"!%08x"` of node num. |
| 2 | `long_name` | string | yes | Empty = keep. Whitespace-only = `BAD_REQUEST`. Max 39 bytes (2.7.x), 24 bytes (2.8, UTF-8-safe truncation). Invalid UTF-8 sanitised. |
| 3 | `short_name` | string | yes | Max 4 bytes. Same empty/whitespace rules. |
| 4 | `macaddr` | bytes | no | deprecated |
| 5 | `hw_model` | `HardwareModel` | no | |
| 6 | `is_licensed` | bool | yes | true → all channel PSKs cleared, admin channel disabled, PKC disabled, public key not broadcast; 2.8 regenerates identity (node number may change, warning sent). Normally set via `set_ham_mode (18)`. |
| 7 | `role` | `Role` | no | Mirrors `device.role`. |
| 8 | `public_key` | bytes(32) | no | Mirrors `security.public_key`. |
| 9 | `is_unmessagable` | optional bool | yes | Applied only when present. Role defaults set it for ROUTER/ROUTER_LATE/SENSOR/TRACKER/TAK_TRACKER. |

Owner change → NodeInfo broadcast (`MeshService::reloadOwner(true)`, skipped inside a
transaction) and reboot (if anything changed).

---

## 7. Size limits (nanopb, firmware 2.7.26/2.8.0)

| Field | Max bytes (excl. NUL) |
|---|---|
| `User.long_name` | 39 (2.8 enforces 24) |
| `User.short_name` | 4 |
| `ChannelSettings.name` | 11 |
| `ChannelSettings.psk` | 32 |
| `DeviceConfig.tzdef` | 64 |
| `NetworkConfig.wifi_ssid` / `wifi_psk` | 32 / 64 |
| `MQTTConfig.address` / `username` / `password` / `root` | 63 / 63 / 31 / 31 |
| `StatusMessageConfig.node_status` | 79 |
| canned messages | 200 |
| ringtone | 230 |
| `Waypoint.name` / `description` | 29 / 99 |
| `RemoteHardwareConfig.available_pins` | 4 entries |
| `SecurityConfig.admin_key` | 3 entries |
| `Data.payload` | 233 (`Constants.DATA_PAYLOAD_LEN`), minus 12 when PKC |
