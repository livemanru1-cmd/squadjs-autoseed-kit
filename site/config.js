export const AUTOSEED_CONFIG = Object.freeze({
  refreshIntervalMs: 15000,
  staleAfterMs: 90000,
  exporters: [
    {
      code: "server-1",
      name: "My Squad Server",
      priority: 10,
      snapshotUrl: "https://exporter.example.org/v1/autoseed/snapshot",
      joinLinkUrl: "https://exporter.example.org/v1/autoseed/join-link"
    }
  ]
});
