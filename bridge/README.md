# meshmash-bridge

A web page cannot open TCP connections, so meshmash reaches radios on WiFi through this small
program. It runs on your computer, listens on `127.0.0.1:4404` only, and relays bytes between
the meshmash page and the radio's TCP port. It does not read or store your messages.

```
meshmash page  ──WebSocket 127.0.0.1:4404──▶  meshmash-bridge  ──TCP──▶  radio on WiFi
```

Works on Windows and Linux (macOS untested). The bridge runs on the same computer as the
browser, not on the server that hosts the meshmash pages.

## Requirements

- Node.js 22.18 or newer (Node 24 LTS recommended): <https://nodejs.org/en/download>
- Git: <https://git-scm.com/downloads>. Without Git, download the repository as a ZIP from
  GitHub (**Code → Download ZIP**). On Linux, both are also in the distribution's package manager.
- A radio with WiFi. ESP32-based radios generally have it (Heltec V3/V4, T-Beam, XIAO ESP32-S3
  and others); nRF52-based radios (RAK4631, T-Echo, XIAO nRF52840 and others) have none.
- The radio on your WiFi network:
  - **Meshtastic:** WiFi enabled in the network settings (official app or CLI). The radio
    listens on TCP port 4403. On ESP32 boards, Bluetooth is off while WiFi is on.
  - **MeshCore:** a companion WiFi firmware build (`*_companion_radio_wifi`), with the network
    name and password set at build time (`WIFI_SSID`, `WIFI_PWD`). The radio listens on TCP
    port 5000.
- The radio's IP address. Give it a fixed one (a DHCP reservation in your router) so the bridge
  config stays valid.

## Install

```sh
git clone https://github.com/petrisi/meshmash.git
cd meshmash/bridge
npm install
```

## Add your radios

```sh
node src/cli.ts add "Home base" 192.168.1.50:5000          # MeshCore
node src/cli.ts add "Backyard radio" 192.168.1.51:4403     # Meshtastic
node src/cli.ts list
```

The protocol follows from the port: 4403 is Meshtastic, 5000 is MeshCore. For another port,
add `--meshtastic` or `--meshcore`. Without a port, give the protocol and the default port is
used: `node src/cli.ts add "Backyard radio" 192.168.1.51 --meshtastic`.

Remove one with `node src/cli.ts remove "Home base"`.

## Run

```sh
node src/cli.ts
```

Leave it running while you use meshmash. Then, in meshmash:

1. On the connect screen, choose **Show WiFi radios**.
2. Chrome and Edge ask once whether the site may access devices on your local network. Allow it;
   the page cannot reach the bridge otherwise.
3. Choose your radio.

meshmash reconnects by itself after a page reload or a dropped connection, as long as the
bridge is running.

If you denied the browser prompt: click the icon left of the address, open the site settings
and set **Local network access** to Allow.

## Options

| Command | |
|---|---|
| `node src/cli.ts --serve <dir>` | Also serve a built meshmash (`npm run build` in the repository root produces `dist/`) at `http://127.0.0.1:4404/`. Needs no browser prompt and works offline. |
| `node src/cli.ts origin add <origin>` | Allow another page origin, e.g. a self-hosted copy of meshmash. |
| `node src/cli.ts token on` | Require a token from pages. Prints a pairing link; open it once in the browser. |
| `node src/cli.ts --help` | All commands. |

The config file is `%APPDATA%\meshmash-bridge\config.json` on Windows and
`~/.config/meshmash-bridge/config.json` on Linux. Set `MESHMASH_BRIDGE_CONFIG` to use another
file.

## Start at login

**Windows:** create a shortcut in `shell:startup` with the target
`node C:\path\to\meshmash\bridge\src\cli.ts`.

**Linux (systemd user service):** `~/.config/systemd/user/meshmash-bridge.service`:

```ini
[Unit]
Description=meshmash-bridge

[Service]
ExecStart=/usr/bin/node %h/meshmash/bridge/src/cli.ts
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now meshmash-bridge`.

## Security

- Listens on 127.0.0.1 only; other computers cannot connect.
- Accepts only pages from allowed origins (default `https://www.simol.in`) and its own;
  other websites you visit cannot use it.
- Connects only to the radios in its config; a page cannot make it connect anywhere else.
- Logs connections, never message contents.

## Troubleshooting

| Message | |
|---|---|
| No bridge answering at 127.0.0.1:4404 | The bridge is not running, or runs on another port. |
| Radio unreachable | Wrong address or port, radio off, or not on the network. |
| The radio is in use by another meshmash window | Another tab or browser has it. Choose the radio again to take it over. |
| Port 4404 is in use | Another bridge is already running. |

Each radio accepts one TCP client at a time. A phone app connected to the same radio over WiFi
and meshmash will disconnect each other.
