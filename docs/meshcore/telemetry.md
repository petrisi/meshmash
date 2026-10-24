# Telemetry

This document covers telemetry requests, the CayenneLPP payload the firmware returns, and the
companion's own telemetry settings.

Sources, at `companion-v1.17.1` unless noted:

- `examples/companion_radio/MyMesh.cpp` (`CMD_SEND_TELEMETRY_REQ`, `onContactRequest`,
  `onContactResponse`)
- `src/helpers/BaseChatMesh.cpp` (`sendRequest`)
- `src/helpers/SensorManager.h`
- `src/helpers/sensors/EnvironmentSensorManager.cpp`
- `src/helpers/sensors/LPPDataHelpers.h`
- repeater, room and sensor `handleRequest`
- the CayenneLPP library pinned in `platformio.ini`: `electroniccats/CayenneLPP @ 1.6.1`
  (`src/CayenneLPP.cpp`)

## 1. Requesting telemetry from a contact

### 1.1 `CMD_SEND_TELEMETRY_REQ` (39), remote form

`[39][r0][r1][r2][pubkey 32]`: three reserved bytes (send 0), then the public key. The
length must be at least 36.

- The contact must be in the companion's contacts. If it is not, the reply is `ERR(2)`.
- The companion sends `PAYLOAD_TYPE_REQ` with plaintext
  `[tag u32][0x03][0 0 0 0][random 4]` (`sendRequest(contact, REQ_TYPE_GET_TELEMETRY_DATA)`).
  Byte 5 is 0, so the inverse permission mask is `~0 = 0xFF`, meaning nothing is masked off
  and the request asks for everything allowed.
- Reply: `RESP_CODE_SENT` `[6][flood][tag u32][est_timeout_ms u32]`.
- Answer: **`PUSH_CODE_TELEMETRY_RESPONSE` (0x8B)**, matched on `tag == pending_telemetry`:

  | Off | Size | Field |
  |---|---|---|
  | 0 | 1 | 0x8B |
  | 1 | 1 | reserved 0 |
  | 2 | 6 | responder pubkey prefix6 |
  | 8 | n | CayenneLPP bytes (the response minus its 4-byte tag) |

- As with every request, a later request of any kind cancels the pending match. See
  companion-protocol.md, section 8.

### 1.2 Via `CMD_SEND_BINARY_REQ` (50): lets you choose a permission mask

`[50][pubkey 32][0x03][inv_mask u8][0][0][0]`. The firmware ANDs the permissions it would
grant with `~inv_mask`. Examples:

- `inv_mask = 0x00`: everything allowed.
- `inv_mask = 0xFE` (`~TELEM_PERM_BASE`): base only. Path discovery uses this.

The answer is `PUSH_CODE_BINARY_RESPONSE` `[0x8C][0][tag u32][LPP...]`. Unlike 0x8B, this
push carries the tag instead of the pubkey prefix.

### 1.3 Self telemetry

`CMD_SEND_TELEMETRY_REQ` with a frame length of **exactly 4**: `[39][0][0][0]`. The answer
is an immediate `PUSH_CODE_TELEMETRY_RESPONSE` `[0x8B][0][own prefix6][LPP]`. No
`RESP_CODE_SENT` is sent. The payload contains, in this order:

1. voltage on channel 1
2. MCU temperature on channel 1, if the board supports it
3. `sensors.querySensors(0xFF, ...)`: GPS on channel 1 (if GPS is active), then
   environment sensors on channels 2 and up

## 2. Who answers and with what

| Responder | Access rule | Content |
|---|---|---|
| Companion (another user's radio) | Decided by the responder's prefs (section 4), using the **requester's contact flags** on the responder. Replies only if the BASE bit survives the checks. | voltage ch1, sensors (by permissions), MCU temperature ch1 |
| Repeater / room | Requester must be logged in (in the ACL). If role == GUEST, the mask is forced to 0, so only base data. | voltage ch1, sensors (by `~inv_mask`; GUEST gets none), MCU temperature ch1 |
| Sensor node | Any ACL member | voltage ch1, sensors with `0xFF & ~inv_mask` |

For a repeater or room, `sensors.querySensors(perm_mask, ...)` receives the inverse-mask
result directly. With `inv_mask = 0` that is `0xFF`, which includes LOCATION and ENVIRONMENT.

Ordering detail: on repeater and room nodes, the MCU temperature is added **after** the
sensors. On the companion's remote reply it is also after the sensors. On companion self
telemetry it comes before them.

Permission bits (`SensorManager.h`):

| Bit | Name | Grants |
|---|---|---|
| 0x01 | `TELEM_PERM_BASE` | battery voltage (and MCU temperature) |
| 0x02 | `TELEM_PERM_LOCATION` | GPS (`LPP_GPS` on channel 1), only when GPS is active |
| 0x04 | `TELEM_PERM_ENVIRONMENT` | all detected I2C environment sensors |

## 3. CayenneLPP format

The payload is a concatenation of records `[channel u8][type u8][value, big-endian]`. Channel
0 marks the end of data (`LPPReader::readHeader`). Values are big-endian two's complement
when the type is signed.

**Signedness, from `CayenneLPP::getTypeSigned` in 1.6.1.** Voltage, current, analog
in/out, temperature, accelerometer, altitude, gyrometer and GPS are **signed**. All other
types are unsigned. Library header comments that call voltage and current "unsigned" are
wrong for this version.

Encoding happens in `addField`: the value is multiplied by the multiplier and truncated to an
integer, and the bytes are written MSB first.

| Type id | Name | Size | Scale (value = raw / mult) | Signed | Emitted by MeshCore v1.17.1 |
|---|---|---|---|---|---|
| 0 | DIGITAL_INPUT | 1 | 1 | no | - |
| 1 | DIGITAL_OUTPUT | 1 | 1 | no | - |
| 2 | ANALOG_INPUT | 2 | /100 | yes | BME680 BSEC accuracy |
| 3 | ANALOG_OUTPUT | 2 | /100 | yes | - |
| 100 (0x64) | GENERIC_SENSOR | 4 | 1 | no | BME680 gas resistance (ohm), BSEC IAQ |
| 101 (0x65) | LUMINOSITY | 2 | 1 lux | no | - |
| 102 (0x66) | PRESENCE | 1 | 1 | no | - |
| 103 (0x67) | TEMPERATURE | 2 | /10 deg C | yes | MCU, AHTx0, BME/BMP, SHT, LPS22, MLX90614 (2 channels), RAK12035 |
| 104 (0x68) | RELATIVE_HUMIDITY | 1 | /2 % | no | AHTx0, BME280/680, SHTxx |
| 113 (0x71) | ACCELEROMETER | 6 | 3 x i16 /1000 G | yes | - |
| 115 (0x73) | BAROMETRIC_PRESSURE | 2 | /10 hPa | no | BME/BMP, LPS22 |
| 116 (0x74) | VOLTAGE | 2 | /100 V | **yes** | battery (ch1), INA219/226/260/3221 |
| 117 (0x75) | CURRENT | 2 | /1000 A | **yes** | INA2xx/3221 |
| 118 (0x76) | FREQUENCY | 4 | 1 Hz | no | RAK12035 calibration channel (raw capacitance) |
| 120 (0x78) | PERCENTAGE | 1 | 1 % | no | RAK12035 soil moisture |
| 121 (0x79) | ALTITUDE | 2 | 1 m | yes | BME/BMP (computed from pressure) |
| 125 (0x7D) | CONCENTRATION | 2 | 1 ppm | no | - |
| 128 (0x80) | POWER | 2 | 1 W (integer watts) | no | INA2xx (`V*I`); sub-watt values truncate to 0 |
| 130 (0x82) | DISTANCE | 4 | /1000 m | no | VL53L0X |
| 131 (0x83) | ENERGY | 4 | /1000 kWh | no | - |
| 132 (0x84) | DIRECTION | 2 | 1 deg | no | - |
| 133 (0x85) | UNIXTIME | 4 | 1 s | no | - |
| 134 (0x86) | GYROMETER | 6 | 3 x i16 /100 deg/s | yes | - |
| 135 (0x87) | COLOUR | 3 | R, G, B bytes | no | - |
| 136 (0x88) | GPS | 9 | lat i24 /1e4 deg, lon i24 /1e4 deg, alt i24 /100 m | yes | GPS on ch1 (only if `gps_active` and LOCATION allowed) |
| 142 (0x8E) | SWITCH | 1 | 0/1 | no | - |
| 240 (0xF0) | POLYLINE | >= 8 (variable) | see library | - | - |

Notes:

- **Channel assignment.** Channel 1 (`TELEM_CHANNEL_SELF`) carries battery voltage, MCU
  temperature and GPS. Environment sensors get channels 2, 3, ... in the order they were
  detected and initialised, one channel per sensor sub-unit. For example, INA3221 uses one
  channel per enabled input, MLX90614 uses two (object, then ambient), and RAK12035 uses two
  (moisture, then calibration). So channel numbers are stable only for a fixed hardware
  configuration.
- **Duplicate types per channel.** BME680 on channel n emits temperature, humidity, pressure,
  altitude and gas, all on channel n. Key decoded values by `(channel, type)`.
- **The RAK12035 calibration channel reuses types**: FREQUENCY carries raw capacitance,
  TEMPERATURE carries the "wet" calibration value, and POWER carries the "dry" value
  (`EnvironmentSensorManager.cpp`, around line 468). They are not physical units.
- **GPS precision** is 1e-4 degrees (about 11 m) because of the LPP format.
- **Buffer size.** The LPP buffer is `MAX_PACKET_PAYLOAD - 4 = 180` bytes. When it is full,
  later fields are silently dropped (`LPP_ERROR_OVERFLOW`). The decoder also has to cope with
  frame clamping at 176 bytes.
- An **unknown type** cannot be skipped safely. `LPPReader::skipData` falls back to 1 byte,
  which is not reliable, so stop decoding at the first unknown type.

## 4. Companion telemetry prefs (who may read *this* radio)

The prefs are three 2-bit modes, `NodePrefs::telemetry_mode_base`, `_loc` and `_env`:

| Mode | Value | Meaning |
|---|---|---|
| `TELEM_MODE_DENY` | 0 | never |
| `TELEM_MODE_ALLOW_FLAGS` | 1 | only if the requesting contact's flags grant it: `(contact.flags >> 1) & PERM_BIT` |
| `TELEM_MODE_ALLOW_ALL` | 2 | anyone who is a contact (the request must decrypt, so the requester must be in contacts) |

To read them, take `SELF_INFO` byte 46: `base = b & 3`, `loc = (b>>2) & 3`,
`env = (b>>4) & 3`.

To write them, use `CMD_SET_OTHER_PARAMS` (38): `[38][manual_add][modes][adv_loc][multi_acks]`,
with `modes = env<<4 | loc<<2 | base`. See config.md.

Per-contact grants live in the contact `flags` byte, written with `CMD_ADD_UPDATE_CONTACT`:

| flags bit | Meaning |
|---|---|
| 0 (0x01) | favourite (also protects the contact from overwrite-oldest) |
| 1 (0x02) | grant BASE |
| 2 (0x04) | grant LOCATION |
| 3 (0x08) | grant ENVIRONMENT |
| 4 (0x10) | 1.18+: allow remote CLI (`isRemoteCLIAllowed`) |

`onContactRequest` builds the result as `permissions = f(modes, flags) & ~inv_mask`, and
replies **only if `permissions & BASE` is set**. Location therefore cannot be shared without
base. A denied request gets no reply, so the requester times out.

## 5. Sensor min/max/avg (simple_sensor only)

This is `REQ_TYPE_GET_AVG_MIN_MAX` (0x04), sent with `CMD_SEND_BINARY_REQ`:

```
[50][pubkey32][0x04][start_secs_ago u32][end_secs_ago u32][0][0]
```

The requester's role must be at least READ_ONLY. The response body (after the tag) is
`[sensor_now u32]`, followed by up to 8 entries of `[channel][lpp_type][min][max][avg]`.
Each value is big-endian, encoded with **SensorMesh's own** `getDataSize`, `getMultiplier`
and `isSigned` tables, not the library's. These differ from section 3:

- RELATIVE_HUMIDITY is **2 bytes /10** here.
- VOLTAGE and CURRENT are **unsigned** here.
- Types the table doesn't list default to 1 byte with multiplier 1.

Source: `SensorMesh.cpp` `handleRequest`, `putFloat`. This was read from source and has not
been verified on air.

## 6. Custom vars (companion's own sensor settings)

- `CMD_GET_CUSTOM_VARS` (40) replies with `RESP_CODE_CUSTOM_VARS` (21) followed by ASCII
  `"name:value,name:value"`, capped at about 140 chars. With `EnvironmentSensorManager`, the
  only var is `gps` (`"0"` or `"1"`), and it is listed only if a GPS was detected.
- `CMD_SET_CUSTOM_VAR` (41): `[41]["name:value"]`, minimum length 4. Setting `gps:1` or
  `gps:0` also persists `gps_enabled`. Any other name, or a missing `:`, returns `ERR(6)`.
