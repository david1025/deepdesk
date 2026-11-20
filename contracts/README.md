# Platform contracts

- [Bridge v1](bridge-v1.d.ts) defines the macOS native bridge interface.
- [Sync v1](sync-v1.schema.json) is the draft schema for Windows, macOS and Android. See the [protocol design](../docs/macos/05-lan-sync.md) and [V1 acceptance checklist](../docs/macos/06-v1-acceptance.md#f-局域网同步).

When integrating the Android client, import the schema and any shared, sanitized test fixtures from a fixed desktop Git commit. Record the commit in Android and update it together with the corresponding compatibility tests. Wire-format changes require a new version and upgrade path. Sync v1 interoperability remains pending.
