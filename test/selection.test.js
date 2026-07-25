import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseSeedServer,
  collectServers,
  isAvailableSeedServer,
  isFreshSnapshot
} from "../site/selection.js";

const NOW = Date.parse("2026-07-25T10:00:00.000Z");

test("fresh snapshot rejects stale or failed data", () => {
  assert.equal(isFreshSnapshot({ success: true, stale: false, timestamp: NOW - 1000 }, NOW, 90000), true);
  assert.equal(isFreshSnapshot({ success: true, stale: true, timestamp: NOW }, NOW, 90000), false);
  assert.equal(isFreshSnapshot({ success: true, stale: false, timestamp: NOW - 90001 }, NOW, 90000), false);
});

test("configured priority wins before current population", () => {
  const selected = chooseSeedServer([
    {
      code: "spec-ops",
      priority: 20,
      fresh: true,
      online: true,
      isSeedCandidate: true,
      playerCount: 40,
      maxPlayers: 100
    },
    {
      code: "mix",
      priority: 10,
      fresh: true,
      online: true,
      isSeedCandidate: true,
      playerCount: 5,
      maxPlayers: 100
    }
  ]);
  assert.equal(selected.code, "mix");
});

test("offline, stale, full and non-candidate servers cannot be selected", () => {
  const base = {
    priority: 10,
    fresh: true,
    online: true,
    isSeedCandidate: true,
    playerCount: 50,
    maxPlayers: 100
  };
  assert.equal(isAvailableSeedServer(base), true);
  assert.equal(isAvailableSeedServer({ ...base, online: false }), false);
  assert.equal(isAvailableSeedServer({ ...base, fresh: false }), false);
  assert.equal(isAvailableSeedServer({ ...base, isSeedCandidate: false }), false);
  assert.equal(isAvailableSeedServer({ ...base, playerCount: 100 }), false);
});

test("snapshot and page config are joined by stable server code", () => {
  const config = {
    staleAfterMs: 90000,
    exporters: [
      {
        code: "mix",
        name: "Fallback",
        priority: 10,
        snapshotUrl: "https://example.org/snapshot",
        joinLinkUrl: "https://example.org/join-link"
      }
    ]
  };
  const rows = collectServers(
    [
      {
        ok: true,
        snapshot: {
          success: true,
          stale: false,
          timestamp: NOW,
          servers: [
            {
              code: "mix",
              name: "Mix Server",
              online: true,
              isSeedCandidate: true,
              playerCount: 20,
              maxPlayers: 100,
              queueLength: 2
            }
          ]
        }
      }
    ],
    config,
    NOW
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Mix Server");
  assert.equal(rows[0].priority, 10);
  assert.equal(rows[0].joinLinkUrl, "https://example.org/join-link");
});
