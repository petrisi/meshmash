# meshmash

Browser client for Meshtastic® and MeshCore LoRa mesh radios.

- Connects to one radio at a time over USB serial (Web Serial; Chromium-based browsers)
- Detects the radio's protocol and firmware and adapts the interface
- Channels, direct messages, node list, node actions (traceroute / path discovery, telemetry, …)

Status: interface prototype with demo data. Radio connectivity is not implemented yet.

## Development

```sh
npm install
npm run dev     # http://localhost:5173
npm run check   # type check
npm run build
```

## License

GPL-3.0-only. See [LICENSE](LICENSE).

Not affiliated with or endorsed by Meshtastic LLC or the MeshCore project.
Meshtastic® is a registered trademark of Meshtastic LLC.
