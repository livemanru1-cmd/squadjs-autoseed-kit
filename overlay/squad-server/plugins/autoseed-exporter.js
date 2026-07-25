import { Agent as HttpAgent, createServer, request as httpRequest } from 'http';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';
import crypto from 'crypto';

import BasePlugin from './base-plugin.js';
import { readBuildIdentity } from '../utils/build-identity.js';
import { isPublicSessionId } from '../utils/public-session.js';

const DEFAULT_PATH_PREFIX = '/v1/autoseed';
const DEFAULT_SQUADBROWSER_API_BASE_URL = 'https://api.squadbrowser.app/api';
const DEFAULT_SQUADBROWSER_TIMEOUT_MS = 4000;
const DEFAULT_SQUADBROWSER_KEEPALIVE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_STREAM_HEARTBEAT_MS = 5 * 1000;
const DEFAULT_EVENT_STREAM_MAX_CONNECTIONS_PER_IP = 4;
const RELEASE_WINDOW_PHASES = new Set(['unknown', 'in_match', 'intermission']);

function createJsonBuffer(payload) {
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildSnapshotSignature(snapshot) {
  const servers = Array.isArray(snapshot?.servers)
    ? snapshot.servers.map(({ updatedAt, ...server }) => server)
    : [];

  return JSON.stringify({
    success: Boolean(snapshot?.success),
    version: safeNumber(snapshot?.version, 0),
    stale: Boolean(snapshot?.stale),
    servers
  });
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeString(value) {
  if (typeof value !== 'string') return value;
  return value.trim();
}

function buildPublicPlayerMatchKey(player) {
  const steamID = normalizeString(player?.steamID);
  if (!steamID) return null;
  const digest = crypto.createHash('sha256').update(`steam:${steamID}`).digest('hex');
  return `steam:${digest}`;
}

function normalizeUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function isUnresolvedEnvPlaceholder(value) {
  return typeof value === 'string' && (/^\$\{[^}]+\}$/.test(value) || /^\$[A-Z0-9_]+$/.test(value));
}

function formatHours(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return Math.round((seconds / 3600) * 10) / 10;
}

function isPrivatePlayerIdKey(key) {
  const normalized = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return (
    normalized === 'eosid' ||
    normalized === 'steamid' ||
    normalized === 'discordid' ||
    normalized === 'playerid' ||
    normalized === 'playerids'
  );
}

function sanitizePublicPluginState(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizePublicPluginState(item));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isPrivatePlayerIdKey(key))
      .map(([key, item]) => [key, sanitizePublicPluginState(item)])
  );
}

function normalizeEventCounts(value) {
  return {
    kills: Math.max(0, Math.floor(safeNumber(value?.kills, 0))),
    damage: Math.max(0, Math.floor(safeNumber(value?.damage, 0))),
    knockdowns: Math.max(0, Math.floor(safeNumber(value?.knockdowns, 0))),
    revives: Math.max(0, Math.floor(safeNumber(value?.revives, 0))),
    vehicles: Math.max(0, Math.floor(safeNumber(value?.vehicles, 0)))
  };
}

function buildLightSessionIndex(value) {
  if (!value || typeof value !== 'object') return {};
  const session = { ...value };
  delete session.scoreboard;
  delete session.events;
  return session;
}

function deduplicatePlayers(players = []) {
  const unique = [];
  const seen = new Set();

  for (const player of players) {
    const key = player?.eosID || player?.steamID || player?.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(player);
  }

  return unique;
}

function sortPlayerRows(left, right) {
  if ((left.teamId || 0) !== (right.teamId || 0)) return (left.teamId || 0) - (right.teamId || 0);
  if ((left.squadId || 0) !== (right.squadId || 0))
    return (left.squadId || 0) - (right.squadId || 0);
  if (left.isCommander !== right.isCommander) return left.isCommander ? -1 : 1;
  if (left.isLeader !== right.isLeader) return left.isLeader ? -1 : 1;
  if ((right.playtimeSeconds || 0) !== (left.playtimeSeconds || 0))
    return (right.playtimeSeconds || 0) - (left.playtimeSeconds || 0);
  return String(left.name || '').localeCompare(String(right.name || ''), 'ru');
}

export default class AutoseedExporter extends BasePlugin {
  static get description() {
    return 'Read-only public snapshot exporter for fully-static AutoSeed frontend.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      listenHost: {
        required: false,
        description: 'Local host to bind the HTTP server.',
        default: '0.0.0.0'
      },
      listenPort: {
        required: false,
        description: 'Local HTTP port for public snapshot endpoint.',
        default: 32080,
        type: 'number'
      },
      pathPrefix: {
        required: false,
        description: 'Prefix for the public API routes.',
        default: DEFAULT_PATH_PREFIX
      },
      serverId: {
        required: false,
        description: 'Stable public server id.',
        default: 0,
        type: 'number'
      },
      serverCode: {
        required: false,
        description: 'Stable public server code.',
        default: ''
      },
      serverName: {
        required: false,
        description: 'Fallback public server name used before ShowServerInfo is available.',
        default: ''
      },
      isSeedCandidate: {
        required: false,
        description: 'Whether this server can be selected as seed target.',
        default: true,
        type: 'boolean'
      },
      squadbrowserApiBaseUrl: {
        required: false,
        description: 'Base URL of Squadbrowser API.',
        default: DEFAULT_SQUADBROWSER_API_BASE_URL
      },
      squadbrowserApiKey: {
        required: false,
        description: 'API key for Squadbrowser public endpoints.',
        default: ''
      },
      squadbrowserTimeoutMs: {
        required: false,
        description: 'Timeout for Squadbrowser join-link requests.',
        default: DEFAULT_SQUADBROWSER_TIMEOUT_MS,
        type: 'number'
      },
      squadbrowserKeepaliveTimeoutMs: {
        required: false,
        description:
          'How long to keep the outbound Squadbrowser connection alive between requests.',
        default: DEFAULT_SQUADBROWSER_KEEPALIVE_TIMEOUT_MS,
        type: 'number'
      },
      corsOrigins: {
        required: false,
        description: 'Allowed CORS origins for browser clients.',
        default: ['http://localhost:5173']
      },
      staleAfterMs: {
        required: false,
        description: 'Mark server offline if data is older than this value.',
        default: 90000,
        type: 'number'
      },
      eventStreamHeartbeatMs: {
        required: false,
        description: 'Heartbeat interval for SSE keepalive comments.',
        default: DEFAULT_EVENT_STREAM_HEARTBEAT_MS,
        type: 'number'
      },
      eventStreamMaxConnectionsPerIp: {
        required: false,
        description: 'Maximum concurrent SSE connections allowed per client IP.',
        default: DEFAULT_EVENT_STREAM_MAX_CONNECTIONS_PER_IP,
        type: 'number'
      },
      rateLimitWindowMs: {
        required: false,
        description: 'Rate limit window in milliseconds.',
        default: 60000,
        type: 'number'
      },
      rateLimitMaxRequests: {
        required: false,
        description: 'Maximum requests per client IP inside the rate limit window.',
        default: 120,
        type: 'number'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.httpServer = createServer(this.handleRequest.bind(this));
    this.pathPrefix = this.normalizePathPrefix(this.options.pathPrefix || DEFAULT_PATH_PREFIX);
    this.snapshotPath = `${this.pathPrefix}/snapshot`;
    this.joinLinkPath = `${this.pathPrefix}/join-link`;
    this.eventStreamPath = `${this.pathPrefix}/events`;
    this.activitySessionsPath = `${this.pathPrefix}/activity/sessions/`;
    this.healthPath = '/healthz';
    this.prefixedHealthPath = `${this.pathPrefix}/healthz`;
    this.livenessPath = '/livez';
    this.prefixedLivenessPath = `${this.pathPrefix}/livez`;
    this.readinessPath = '/readyz';
    this.prefixedReadinessPath = `${this.pathPrefix}/readyz`;
    this.buildIdentity = readBuildIdentity();
    this.requestRateLimit = new Map();
    this.refreshDebounceTimer = null;
    this.staleSnapshotTimer = null;
    this.snapshotPromise = null;
    this.mounted = false;
    this.lifecycleGeneration = 0;
    this.lastExporterUpdateAt = 0;
    this.lastPlayerUpdateAt = 0;
    this.lastServerUpdateAt = 0;
    this.eventClients = new Map();
    this.eventHeartbeatTimer = null;
    this.boundPlayerRefresh = this.handlePlayerRefresh.bind(this);
    this.boundServerRefresh = this.handleServerRefresh.bind(this);
    this.boundStartupReadinessRefresh = this.handleStartupReadinessRefresh.bind(this);
    this.boundReleaseWindowRoundEnded = this.handleReleaseWindowRoundEnded.bind(this);
    this.boundReleaseWindowNewGame = this.handleReleaseWindowNewGame.bind(this);
    this.releaseWindow = this.createReleaseWindow('unknown');
    this.warnedSquadbrowserConfig = false;
    this.squadbrowserAgent = null;
    this.squadbrowserAgentKey = '';
    this.squadbrowserAgentKeepAliveMs = 0;
    this.lastSnapshot = this.buildFallbackSnapshot(Date.now());
    this.lastSnapshotSignature = buildSnapshotSignature(this.lastSnapshot);
  }

  createReleaseWindow(phase) {
    const normalizedPhase = RELEASE_WINDOW_PHASES.has(phase) ? phase : 'unknown';
    return {
      phase: normalizedPhase,
      boundaryToken: `rw_${crypto.randomBytes(16).toString('hex')}`,
      changedAt: new Date().toISOString()
    };
  }

  setReleaseWindowPhase(phase) {
    this.releaseWindow = this.createReleaseWindow(phase);
    this.lastSnapshot = this.withCurrentReleaseWindow(this.lastSnapshot);
    if (this.mounted) {
      this.broadcastSnapshot(this.lastSnapshot);
      this.scheduleSnapshotRefresh();
    }
  }

  handleReleaseWindowRoundEnded() {
    this.setReleaseWindowPhase('intermission');
  }

  handleReleaseWindowNewGame() {
    this.setReleaseWindowPhase('in_match');
  }

  getReleaseWindowSnapshot() {
    return { ...this.releaseWindow };
  }

  withCurrentReleaseWindow(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.servers)) {
      return snapshot;
    }

    const serverCode = this.resolveServerCode();
    const releaseWindow = this.getReleaseWindowSnapshot();
    return {
      ...snapshot,
      servers: snapshot.servers.map((server) =>
        server?.code === serverCode ? { ...server, releaseWindow } : server
      )
    };
  }

  normalizePathPrefix(value) {
    const raw = typeof value === 'string' && value.length ? value : DEFAULT_PATH_PREFIX;
    const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
    return prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
  }

  resolveServerId() {
    return safeNumber(this.options.serverId, safeNumber(this.server.id, 0));
  }

  resolveServerCode() {
    if (this.options.serverCode) return this.options.serverCode;
    const serverId = this.resolveServerId();
    return serverId ? `server-${serverId}` : 'server';
  }

  resolveServerName() {
    return this.server.serverName || this.options.serverName || `Server ${this.resolveServerId()}`;
  }

  resolveSquadbrowserBaseUrl() {
    const value = normalizeUrl(this.options.squadbrowserApiBaseUrl);
    if (value && !isUnresolvedEnvPlaceholder(value)) return value;
    return DEFAULT_SQUADBROWSER_API_BASE_URL;
  }

  resolveSquadbrowserApiKey() {
    const value = normalizeString(this.options.squadbrowserApiKey);
    if (value && !isUnresolvedEnvPlaceholder(value)) return value;
    return '';
  }

  logMissingSquadbrowserConfig() {
    if (this.warnedSquadbrowserConfig) return;
    this.warnedSquadbrowserConfig = true;
    this.verbose(
      1,
      'Squadbrowser join-link lookup is disabled: set squadbrowserApiKey to enable it.'
    );
  }

  resolveSquadbrowserKeepAliveTimeoutMs() {
    return Math.max(
      1000,
      Number(this.options.squadbrowserKeepaliveTimeoutMs) ||
        DEFAULT_SQUADBROWSER_KEEPALIVE_TIMEOUT_MS
    );
  }

  getSquadbrowserAgent(requestUrl, { rejectUnauthorized = true } = {}) {
    if (!this.mounted) {
      const error = new Error('AutoseedExporter is not mounted.');
      error.code = 'EXPORTER_UNMOUNTED';
      throw error;
    }

    const keepAliveMsecs = this.resolveSquadbrowserKeepAliveTimeoutMs();
    const tlsMode = requestUrl.protocol === 'https:' && !rejectUnauthorized ? ':insecure-tls' : '';
    const agentKey = `${requestUrl.protocol}//${requestUrl.host}${tlsMode}`;

    if (
      this.squadbrowserAgent &&
      this.squadbrowserAgentKey === agentKey &&
      this.squadbrowserAgentKeepAliveMs === keepAliveMsecs
    ) {
      return this.squadbrowserAgent;
    }

    this.destroySquadbrowserAgent();

    const AgentClass = requestUrl.protocol === 'https:' ? HttpsAgent : HttpAgent;
    const agentOptions = {
      keepAlive: true,
      keepAliveMsecs,
      maxSockets: 1,
      maxFreeSockets: 1
    };

    if (requestUrl.protocol === 'https:') {
      agentOptions.rejectUnauthorized = rejectUnauthorized;
    }

    this.squadbrowserAgent = new AgentClass(agentOptions);
    this.squadbrowserAgentKey = agentKey;
    this.squadbrowserAgentKeepAliveMs = keepAliveMsecs;
    return this.squadbrowserAgent;
  }

  destroySquadbrowserAgent() {
    if (this.squadbrowserAgent) {
      this.squadbrowserAgent.destroy();
      this.squadbrowserAgent = null;
    }

    this.squadbrowserAgentKey = '';
    this.squadbrowserAgentKeepAliveMs = 0;
  }

  async requestJson(
    requestUrl,
    { method = 'GET', headers = {}, body = null, timeoutMs = 0, rejectUnauthorized = true } = {}
  ) {
    const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload =
      typeof body === 'string' || Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : null;

    return await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          headers: {
            ...headers,
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
          },
          agent: this.getSquadbrowserAgent(url, { rejectUnauthorized })
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let parsedBody = null;

            if (rawBody.length) {
              try {
                parsedBody = JSON.parse(rawBody);
              } catch (err) {
                reject(new Error(`Invalid JSON response: ${err.message}`));
                return;
              }
            }

            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              body: parsedBody,
              rawBody
            });
          });
        }
      );

      req.on('error', reject);

      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
        });
      }

      if (payload) {
        req.write(payload);
      }

      req.end();
    });
  }

  async fetchSquadbrowserJoinLink(serverName) {
    const baseUrl = this.resolveSquadbrowserBaseUrl();
    const apiKey = this.resolveSquadbrowserApiKey();
    if (!apiKey || !serverName) {
      if (!apiKey) this.logMissingSquadbrowserConfig();
      return null;
    }

    const timeoutMs = Math.max(
      250,
      Number(this.options.squadbrowserTimeoutMs) || DEFAULT_SQUADBROWSER_TIMEOUT_MS
    );
    const requestUrl = new URL(`${baseUrl}/pub/join-link`);
    const requestOptions = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: { serverName },
      timeoutMs
    };

    try {
      const response = await this.requestJson(requestUrl, requestOptions);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        this.verbose(1, `Squadbrowser join-link lookup failed with HTTP ${response.statusCode}.`, {
          serverName,
          baseUrl
        });
        return null;
      }

      const joinUrl = normalizeString(response.body?.joinUrl);
      return joinUrl || null;
    } catch (err) {
      this.verbose(1, `Squadbrowser join-link lookup failed: ${err.message}`, {
        serverName,
        baseUrl
      });
      return null;
    }
  }

  async requestJoinLink(serverName = this.resolveServerName()) {
    if (!serverName) return null;

    return await this.fetchSquadbrowserJoinLink(serverName);
  }

  getPlaytimeTracker() {
    return (
      this.server.plugins?.find((plugin) => plugin?.constructor?.name === 'PlaytimeTracker') || null
    );
  }

  getRafflePlugin() {
    return this.server.plugins?.find((plugin) => plugin?.constructor?.name === 'Raffle') || null;
  }

  getTeamBalancerPlugin() {
    return (
      this.server.plugins?.find((plugin) => plugin?.constructor?.name === 'TeamBalancer') || null
    );
  }

  getSessionTopBroadcastPlugin() {
    return (
      this.server.plugins?.find((plugin) => plugin?.constructor?.name === 'SessionTopBroadcast') ||
      null
    );
  }

  getKnockdownStackPlugin() {
    return (
      this.server.plugins?.find((plugin) => plugin?.constructor?.name === 'KnockdownStack') || null
    );
  }

  async buildRaffleState() {
    const rafflePlugin = this.getRafflePlugin();
    if (!rafflePlugin || typeof rafflePlugin.getSnapshot !== 'function') return null;

    try {
      return sanitizePublicPluginState(await rafflePlugin.getSnapshot());
    } catch (err) {
      this.verbose(1, `AutoseedExporter raffle snapshot failed: ${err.message}`);
      return null;
    }
  }

  async buildTeamBalancerState() {
    const teamBalancerPlugin = this.getTeamBalancerPlugin();
    if (!teamBalancerPlugin || typeof teamBalancerPlugin.getProposalSnapshot !== 'function')
      return null;

    try {
      return sanitizePublicPluginState(teamBalancerPlugin.getProposalSnapshot());
    } catch (err) {
      this.verbose(1, `AutoseedExporter team balancer snapshot failed: ${err.message}`);
      return null;
    }
  }

  async buildActivityState() {
    const teamBalancerPlugin = this.getTeamBalancerPlugin();
    const activityPlugin = this.getSessionTopBroadcastPlugin();
    const killfeedPlugin = this.getKnockdownStackPlugin();
    let teamBalancerHistory = null;
    let activityState = null;
    let killfeedState = null;

    if (teamBalancerPlugin && typeof teamBalancerPlugin.getOperationHistory === 'function') {
      try {
        teamBalancerHistory = sanitizePublicPluginState(teamBalancerPlugin.getOperationHistory());
      } catch (err) {
        this.verbose(1, `AutoseedExporter team balancer activity history failed: ${err.message}`);
      }
    }

    if (activityPlugin && typeof activityPlugin.getPublicActivitySnapshot === 'function') {
      try {
        activityState = sanitizePublicPluginState(await activityPlugin.getPublicActivitySnapshot());
      } catch (err) {
        this.verbose(1, `AutoseedExporter activity snapshot failed: ${err.message}`);
      }
    }

    if (killfeedPlugin && typeof killfeedPlugin.getPublicKillfeedSnapshot === 'function') {
      try {
        killfeedState = sanitizePublicPluginState(await killfeedPlugin.getPublicKillfeedSnapshot());
      } catch (err) {
        this.verbose(1, `AutoseedExporter killfeed snapshot failed: ${err.message}`);
      }
    }

    if (!teamBalancerHistory && !activityState && !killfeedState) return null;

    const killfeedRounds = Array.isArray(killfeedState?.rounds) ? killfeedState.rounds : [];
    const killfeedBySessionId = new Map(
      killfeedRounds.filter((round) => round?.sessionId).map((round) => [round.sessionId, round])
    );
    const sessions = (
      Array.isArray(activityState?.recentRounds) ? activityState.recentRounds : []
    ).map((value) => {
      const session = buildLightSessionIndex(value);
      const journal = killfeedBySessionId.get(session?.sessionId);
      return {
        ...session,
        journalAvailable: journal?.journalAvailable === true,
        journalComplete: journal?.journalComplete === true,
        eventCounts: normalizeEventCounts(journal?.eventCounts)
      };
    });

    return {
      version: 3,
      generatedAt: new Date().toISOString(),
      teamBalancerHistoryVersion: 2,
      teamBalancerHistory: Array.isArray(teamBalancerHistory) ? teamBalancerHistory : [],
      sessions,
      recentRounds: sessions,
      topWindow: activityState?.topWindow || null,
      killfeed: killfeedState
        ? {
            ...killfeedState,
            events: []
          }
        : null
    };
  }

  async buildActivitySessionDetail(sessionId) {
    const activityPlugin = this.getSessionTopBroadcastPlugin();
    const killfeedPlugin = this.getKnockdownStackPlugin();
    if (!activityPlugin || typeof activityPlugin.getPublicSessionSummary !== 'function')
      return null;

    const [sessionSummary, journal] = await Promise.all([
      activityPlugin.getPublicSessionSummary(sessionId),
      killfeedPlugin && typeof killfeedPlugin.getPublicSessionJournal === 'function'
        ? killfeedPlugin.getPublicSessionJournal(sessionId)
        : null
    ]);
    if (!sessionSummary) return null;

    const emptyEvents = {
      kills: [],
      damage: [],
      knockdowns: [],
      revives: [],
      vehicles: []
    };
    return sanitizePublicPluginState({
      ok: true,
      version: 1,
      generatedAt: new Date().toISOString(),
      server: {
        id: this.resolveServerId(),
        code: this.resolveServerCode(),
        name: this.resolveServerName()
      },
      session: {
        ...sessionSummary,
        journalAvailable: journal?.journalAvailable === true,
        journalComplete: journal?.journalComplete === true,
        eventCounts: normalizeEventCounts(journal?.eventCounts)
      },
      events: journal?.events || emptyEvents
    });
  }

  isCommanderPlayer(player, playtimeTracker) {
    if (!player) return false;

    const normalizedRole = normalizeString(player?.role)?.toLowerCase() || '';
    if (normalizedRole.includes('commander') || normalizedRole.includes('командир')) return true;

    const squadName = player?.squad?.squadName;
    if (
      Boolean(player?.isLeader) &&
      typeof playtimeTracker?.isCommanderSquadName === 'function' &&
      playtimeTracker.isCommanderSquadName(squadName)
    )
      return true;

    return false;
  }

  resolvePlayerTeamName(player, playtimeTracker) {
    const fromSquad = normalizeString(player?.squad?.teamName);
    if (fromSquad) return fromSquad;

    if (typeof playtimeTracker?.getTeamLabel === 'function' && player?.teamID) {
      return playtimeTracker.getTeamLabel(player.teamID);
    }

    if (player?.teamID === 1) return 'Team 1';
    if (player?.teamID === 2) return 'Team 2';
    return 'Unassigned';
  }

  resolvePlayerSquadName(player) {
    const fromSquad = normalizeString(player?.squad?.squadName);
    if (fromSquad) return fromSquad;
    if (Number.isFinite(player?.squadID)) return `Squad ${player.squadID}`;
    return null;
  }

  async buildRosterState(playtimeTracker) {
    const sourcePlayers = deduplicatePlayers(
      Array.isArray(this.server.players) ? this.server.players : []
    );
    const players = await Promise.all(
      sourcePlayers.map(async (player) => {
        let playtime = null;
        try {
          playtime =
            playtimeTracker && typeof playtimeTracker.getPlaytimeForPlayer === 'function'
              ? await playtimeTracker.getPlaytimeForPlayer(player)
              : null;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.verbose(1, `AutoseedExporter playtime lookup failed: ${message}`, {
            steamID: player?.steamID,
            eosID: player?.eosID,
            name: player?.name
          });
        }

        const playtimeSeconds =
          typeof playtime?.seconds === 'number' && Number.isFinite(playtime.seconds)
            ? playtime.seconds
            : null;

        return {
          eosId: normalizeString(player?.eosID) || null,
          steamId: normalizeString(player?.steamID) || null,
          matchKey: buildPublicPlayerMatchKey(player),
          name: normalizeString(player?.name) || 'Unknown',
          teamId: safeNumber(player?.teamID, 0) || null,
          teamName: this.resolvePlayerTeamName(player, playtimeTracker),
          squadId: safeNumber(player?.squadID, 0) || null,
          squadName: this.resolvePlayerSquadName(player),
          role: normalizeString(player?.role) || null,
          isLeader: Boolean(player?.isLeader),
          isCommander: this.isCommanderPlayer(player, playtimeTracker),
          playtimeSeconds,
          playtimeHours: playtimeSeconds !== null ? formatHours(playtimeSeconds) : null,
          playtimeSource: playtime?.source || null
        };
      })
    );

    players.sort(sortPlayerRows);

    const teamsMap = new Map();
    for (const player of players) {
      const teamKey = player.teamId || 0;
      if (!teamsMap.has(teamKey)) {
        teamsMap.set(teamKey, {
          id: player.teamId,
          name: player.teamName,
          playerCount: 0,
          playersWithHours: 0,
          totalPlaytimeSeconds: 0,
          leaderPlaytimeSeconds: 0,
          commanderPlaytimeSeconds: 0,
          players: [],
          squads: new Map()
        });
      }

      const team = teamsMap.get(teamKey);
      team.playerCount += 1;
      team.players.push(player);

      if (typeof player.playtimeSeconds === 'number') {
        team.totalPlaytimeSeconds += player.playtimeSeconds;
        team.playersWithHours += 1;
        if (player.isCommander) {
          team.commanderPlaytimeSeconds += player.playtimeSeconds;
        } else if (player.isLeader) {
          team.leaderPlaytimeSeconds += player.playtimeSeconds;
        }
      }

      const squadKey = player.squadId || 0;
      if (squadKey) {
        if (!team.squads.has(squadKey)) {
          team.squads.set(squadKey, {
            id: player.squadId,
            name: player.squadName || `Squad ${player.squadId}`,
            playerCount: 0,
            totalPlaytimeSeconds: 0,
            leaderName: null,
            leaderPlaytimeSeconds: 0
          });
        }

        const squad = team.squads.get(squadKey);
        squad.playerCount += 1;
        if (typeof player.playtimeSeconds === 'number') {
          squad.totalPlaytimeSeconds += player.playtimeSeconds;
        }
        if (player.isLeader) {
          squad.leaderName = player.name;
          squad.leaderPlaytimeSeconds = player.playtimeSeconds || 0;
        }
      }
    }

    const teams = Array.from(teamsMap.values())
      .filter((team) => team.id)
      .sort((left, right) => left.id - right.id)
      .map((team) => ({
        id: team.id,
        name: team.name,
        playerCount: team.playerCount,
        playersWithHours: team.playersWithHours,
        totalPlaytimeSeconds: team.totalPlaytimeSeconds,
        totalPlaytimeHours: formatHours(team.totalPlaytimeSeconds),
        leaderPlaytimeSeconds: team.leaderPlaytimeSeconds,
        leaderPlaytimeHours: formatHours(team.leaderPlaytimeSeconds),
        commanderPlaytimeSeconds: team.commanderPlaytimeSeconds,
        commanderPlaytimeHours: formatHours(team.commanderPlaytimeSeconds),
        squads: Array.from(team.squads.values())
          .sort((left, right) => {
            if ((right.totalPlaytimeSeconds || 0) !== (left.totalPlaytimeSeconds || 0))
              return (right.totalPlaytimeSeconds || 0) - (left.totalPlaytimeSeconds || 0);
            return (left.id || 0) - (right.id || 0);
          })
          .map((squad) => ({
            id: squad.id,
            name: squad.name,
            playerCount: squad.playerCount,
            totalPlaytimeSeconds: squad.totalPlaytimeSeconds,
            totalPlaytimeHours: formatHours(squad.totalPlaytimeSeconds),
            leaderName: squad.leaderName,
            leaderPlaytimeSeconds: squad.leaderPlaytimeSeconds,
            leaderPlaytimeHours: formatHours(squad.leaderPlaytimeSeconds)
          })),
        players: team.players
      }));

    return { players, teams };
  }

  buildFallbackSnapshot(timestamp) {
    const readiness = this.resolveStartupReadiness();
    const lastUpdatedAt = Math.max(this.lastPlayerUpdateAt || 0, this.lastServerUpdateAt || 0);
    return {
      success: true,
      ready: readiness.ready,
      readiness,
      timestamp,
      generatedAt: new Date(timestamp).toISOString(),
      version: 3,
      servers: [
        {
          id: this.resolveServerId(),
          code: this.resolveServerCode(),
          name: this.resolveServerName(),
          playerCount: safeNumber(
            this.server.playerCount,
            safeNumber(this.server.a2sPlayerCount, 0)
          ),
          maxPlayers: safeNumber(this.server.maxPlayers, 0),
          queueLength: safeNumber(this.server.publicQueue, 0),
          currentLayer:
            this.server.currentLayer?.name || this.server.currentLayer?.classname || null,
          gameMode:
            this.server.currentLayer?.gamemodeType || this.server.currentLayer?.gamemode || null,
          isSeedCandidate: this.options.isSeedCandidate !== false,
          online: false,
          releaseWindow: this.getReleaseWindowSnapshot(),
          teams: [],
          players: [],
          updatedAt: lastUpdatedAt
        }
      ],
      stale: true,
      lastServerUpdateAt: this.lastServerUpdateAt
    };
  }

  handlePlayerRefresh() {
    if (!this.mounted) return;
    this.lastPlayerUpdateAt = Date.now();
    this.scheduleStaleSnapshotRefresh();
    this.scheduleSnapshotRefresh();
  }

  handleServerRefresh() {
    if (!this.mounted) return;
    this.lastServerUpdateAt = Date.now();
    this.scheduleStaleSnapshotRefresh();
    this.scheduleSnapshotRefresh();
  }

  handleStartupReadinessRefresh() {
    if (!this.mounted) return;
    this.scheduleSnapshotRefresh();
  }

  isCurrentGeneration(generation) {
    return this.mounted && generation === this.lifecycleGeneration;
  }

  resolveStartupReadiness() {
    if (typeof this.server?.getStartupReadiness !== 'function') {
      return {
        ready: true,
        phase: 'ready',
        requiredPlugins: 0,
        mountedPlugins: 0,
        reasonCode: null
      };
    }

    const state = this.server.getStartupReadiness() || {};
    return {
      ready: state.ready === true,
      phase: typeof state.phase === 'string' && state.phase ? state.phase : 'initializing',
      requiredPlugins: Math.max(0, Math.floor(safeNumber(state.requiredPlugins, 0))),
      mountedPlugins: Math.max(0, Math.floor(safeNumber(state.mountedPlugins, 0))),
      reasonCode: typeof state.reasonCode === 'string' && state.reasonCode ? state.reasonCode : null
    };
  }

  getStaleAfterMs() {
    return Math.max(1000, Number(this.options.staleAfterMs) || 90000);
  }

  getEventStreamHeartbeatMs() {
    return Math.max(
      1000,
      Number(this.options.eventStreamHeartbeatMs) || DEFAULT_EVENT_STREAM_HEARTBEAT_MS
    );
  }

  getEventStreamMaxConnectionsPerIp() {
    return Math.max(
      1,
      Number(this.options.eventStreamMaxConnectionsPerIp) ||
        DEFAULT_EVENT_STREAM_MAX_CONNECTIONS_PER_IP
    );
  }

  getRateLimitWindowMs() {
    return Math.max(1000, Number(this.options.rateLimitWindowMs) || 60000);
  }

  getRateLimitMaxRequests() {
    return Math.max(1, Number(this.options.rateLimitMaxRequests) || 120);
  }

  getEventClientCount(clientIp) {
    let count = 0;
    for (const connectedClientIp of this.eventClients.values()) {
      if (connectedClientIp === clientIp) {
        count += 1;
      }
    }
    return count;
  }

  detachEventClient(res) {
    if (!this.eventClients.delete(res)) return;

    if (!this.eventClients.size) {
      this.stopEventHeartbeat();
    }
  }

  checkRateLimit(req, bucket = 'default') {
    const now = Date.now();
    const clientIp = getClientIp(req);
    const windowMs = this.getRateLimitWindowMs();
    const maxRequests = this.getRateLimitMaxRequests();
    const bucketKey = `${clientIp}:${bucket}`;
    const existing = this.requestRateLimit.get(bucketKey) || [];
    const activeWindow = existing.filter((timestamp) => now - timestamp < windowMs);

    if (activeWindow.length >= maxRequests) {
      this.requestRateLimit.set(bucketKey, activeWindow);
      return {
        limited: true,
        retryAfterMs: Math.max(1000, windowMs - (now - activeWindow[0]))
      };
    }

    activeWindow.push(now);
    this.requestRateLimit.set(bucketKey, activeWindow);

    return {
      limited: false,
      retryAfterMs: 0
    };
  }

  clearStaleSnapshotRefresh() {
    if (!this.staleSnapshotTimer) return;
    clearTimeout(this.staleSnapshotTimer);
    this.staleSnapshotTimer = null;
  }

  scheduleStaleSnapshotRefresh() {
    this.clearStaleSnapshotRefresh();
    if (!this.mounted) return;

    const generation = this.lifecycleGeneration;

    const lastUpdatedAt = Math.max(this.lastPlayerUpdateAt || 0, this.lastServerUpdateAt || 0);
    if (!lastUpdatedAt) return;

    const delayMs = Math.max(0, lastUpdatedAt + this.getStaleAfterMs() - Date.now());
    this.staleSnapshotTimer = setTimeout(() => {
      this.staleSnapshotTimer = null;
      if (!this.isCurrentGeneration(generation)) return;
      this.refreshSnapshot(generation).catch((err) => {
        this.verbose(1, `AutoseedExporter stale snapshot refresh failed: ${err.message}`);
      });
    }, delayMs);
  }

  startEventHeartbeat() {
    if (this.eventHeartbeatTimer) return;

    this.eventHeartbeatTimer = setInterval(() => {
      if (!this.eventClients.size) return;

      for (const client of Array.from(this.eventClients.keys())) {
        if (client.writableEnded || client.destroyed) {
          this.detachEventClient(client);
          continue;
        }

        client.write(': keepalive\n\n');
      }
    }, this.getEventStreamHeartbeatMs());
  }

  stopEventHeartbeat() {
    if (!this.eventHeartbeatTimer) return;
    clearInterval(this.eventHeartbeatTimer);
    this.eventHeartbeatTimer = null;
  }

  buildSseSnapshotMessage(snapshot) {
    return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  }

  broadcastSnapshot(snapshot) {
    if (!this.eventClients.size) return;

    const payload = this.buildSseSnapshotMessage(snapshot);
    for (const client of Array.from(this.eventClients.keys())) {
      if (client.writableEnded || client.destroyed) {
        this.detachEventClient(client);
        continue;
      }

      client.write(payload);
    }
  }

  openEventStream(req, res) {
    const clientIp = getClientIp(req);
    if (this.getEventClientCount(clientIp) >= this.getEventStreamMaxConnectionsPerIp()) {
      this.sendJson(
        req,
        res,
        429,
        {
          ok: false,
          timestamp: Date.now(),
          error: 'Too many open event streams for client IP'
        },
        {
          'Retry-After': '10'
        }
      );
      return;
    }

    this.applyCors(req, res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    req.socket?.setKeepAlive?.(true, this.getEventStreamHeartbeatMs());
    req.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    this.eventClients.set(res, clientIp);
    this.startEventHeartbeat();
    res.write('retry: 5000\n\n');
    res.write(this.buildSseSnapshotMessage(this.withCurrentReleaseWindow(this.lastSnapshot)));
    this.refreshSnapshot().catch((err) => {
      this.verbose(1, `AutoseedExporter event-stream refresh failed: ${err.message}`);
    });

    const cleanup = () => {
      this.detachEventClient(res);
    };

    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);
  }

  async mount() {
    this.mounted = true;
    this.lifecycleGeneration += 1;
    const generation = this.lifecycleGeneration;

    for (const eventName of [
      'UPDATED_PLAYER_INFORMATION',
      'PLAYER_CONNECTED',
      'PLAYER_DISCONNECTED',
      'PLAYER_TEAM_CHANGE',
      'PLAYER_SQUAD_CHANGE'
    ]) {
      this.server.on(eventName, this.boundPlayerRefresh);
    }

    for (const eventName of [
      'UPDATED_LAYER_INFORMATION',
      'UPDATED_A2S_INFORMATION',
      'UPDATED_SERVER_INFORMATION'
    ]) {
      this.server.on(eventName, this.boundServerRefresh);
    }
    this.server.on('STARTUP_READINESS_CHANGED', this.boundStartupReadinessRefresh);
    this.server.on('ROUND_ENDED', this.boundReleaseWindowRoundEnded);
    this.server.on('NEW_GAME', this.boundReleaseWindowNewGame);

    await this.refreshSnapshot(generation);

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.httpServer.removeListener('error', onError);
        this.httpServer.removeListener('listening', onListening);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };

      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      try {
        this.httpServer.listen(this.options.listenPort, this.options.listenHost);
      } catch (error) {
        onError(error);
      }
    });

    this.verbose(
      1,
      `AutoseedExporter listening on ${this.options.listenHost}:${this.options.listenPort}`
    );
  }

  async unmount() {
    const pendingSnapshot = this.snapshotPromise;
    this.mounted = false;
    this.lifecycleGeneration += 1;

    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }

    this.clearStaleSnapshotRefresh();
    this.stopEventHeartbeat();
    for (const client of Array.from(this.eventClients.keys())) {
      client.end();
    }
    this.eventClients.clear();

    for (const eventName of [
      'UPDATED_PLAYER_INFORMATION',
      'PLAYER_CONNECTED',
      'PLAYER_DISCONNECTED',
      'PLAYER_TEAM_CHANGE',
      'PLAYER_SQUAD_CHANGE'
    ]) {
      this.server.removeListener(eventName, this.boundPlayerRefresh);
    }

    for (const eventName of [
      'UPDATED_LAYER_INFORMATION',
      'UPDATED_A2S_INFORMATION',
      'UPDATED_SERVER_INFORMATION'
    ]) {
      this.server.removeListener(eventName, this.boundServerRefresh);
    }
    this.server.removeListener('STARTUP_READINESS_CHANGED', this.boundStartupReadinessRefresh);
    this.server.removeListener('ROUND_ENDED', this.boundReleaseWindowRoundEnded);
    this.server.removeListener('NEW_GAME', this.boundReleaseWindowNewGame);

    if (this.httpServer.listening) {
      await new Promise((resolve, reject) => {
        this.httpServer.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        this.httpServer.closeAllConnections?.();
      });
    }

    this.destroySquadbrowserAgent();
    if (pendingSnapshot) await pendingSnapshot.catch(() => {});
    this.destroySquadbrowserAgent();
  }

  scheduleSnapshotRefresh() {
    if (!this.mounted) return;
    if (this.refreshDebounceTimer) return;
    const generation = this.lifecycleGeneration;

    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      if (!this.isCurrentGeneration(generation)) return;
      this.refreshSnapshot(generation).catch((err) => {
        this.verbose(1, `AutoseedExporter scheduled refresh failed: ${err.message}`);
      });
    }, 750);
  }

  refreshSnapshot(generation = this.lifecycleGeneration) {
    if (!this.isCurrentGeneration(generation)) return Promise.resolve(this.lastSnapshot);
    if (this.snapshotPromise) return this.snapshotPromise;

    this.snapshotPromise = Promise.resolve()
      .then(async () => {
        const snapshot = this.withCurrentReleaseWindow(await this.buildSnapshot(Date.now()));
        if (!this.isCurrentGeneration(generation)) return this.lastSnapshot;
        const snapshotSignature = buildSnapshotSignature(snapshot);

        if (snapshotSignature === this.lastSnapshotSignature) {
          return this.lastSnapshot;
        }

        this.lastSnapshot = snapshot;
        this.lastSnapshotSignature = snapshotSignature;
        this.lastExporterUpdateAt = snapshot.timestamp;
        this.broadcastSnapshot(snapshot);
        return snapshot;
      })
      .catch((err) => {
        this.verbose(1, `Failed to build Autoseed snapshot: ${err.message}`);
        if (!this.isCurrentGeneration(generation)) {
          return this.withCurrentReleaseWindow(this.lastSnapshot);
        }
        throw err;
      })
      .finally(() => {
        this.snapshotPromise = null;
      });

    return this.snapshotPromise;
  }

  async buildSnapshot(timestamp) {
    const staleAfterMs = this.getStaleAfterMs();
    const readiness = this.resolveStartupReadiness();
    const lastUpdatedAt = Math.max(this.lastPlayerUpdateAt || 0, this.lastServerUpdateAt || 0);
    const stale = !readiness.ready || !lastUpdatedAt || timestamp - lastUpdatedAt > staleAfterMs;
    const playtimeTracker = this.getPlaytimeTracker();
    const rosterState = await this.buildRosterState(playtimeTracker);
    const raffleState = await this.buildRaffleState();
    const teamBalancerState = await this.buildTeamBalancerState(rosterState.players);
    const activityState = await this.buildActivityState();

    return {
      success: true,
      ready: readiness.ready,
      readiness,
      timestamp,
      generatedAt: new Date(timestamp).toISOString(),
      version: 3,
      servers: [
        {
          id: this.resolveServerId(),
          code: this.resolveServerCode(),
          name: this.resolveServerName(),
          playerCount: safeNumber(
            this.server.playerCount,
            safeNumber(this.server.a2sPlayerCount, 0)
          ),
          maxPlayers: safeNumber(this.server.maxPlayers, 0),
          queueLength: safeNumber(this.server.publicQueue, 0),
          currentLayer:
            this.server.currentLayer?.name || this.server.currentLayer?.classname || null,
          gameMode:
            this.server.currentLayer?.gamemodeType || this.server.currentLayer?.gamemode || null,
          isSeedCandidate: this.options.isSeedCandidate !== false,
          online: readiness.ready && !stale,
          releaseWindow: this.getReleaseWindowSnapshot(),
          teams: rosterState.teams,
          players: rosterState.players,
          raffles: raffleState,
          teamBalancer: teamBalancerState,
          activity: activityState,
          updatedAt: lastUpdatedAt
        }
      ],
      stale,
      lastServerUpdateAt: this.lastServerUpdateAt
    };
  }

  applyCors(req, res) {
    const allowedOrigins = Array.isArray(this.options.corsOrigins) ? this.options.corsOrigins : [];
    const origin = req.headers.origin;

    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
  }

  sendJson(req, res, statusCode, payload, headers = null) {
    this.applyCors(req, res);
    const body = createJsonBuffer(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', body.length);
    if (headers && typeof headers === 'object') {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        res.setHeader(headerName, headerValue);
      }
    }
    res.end(body);
  }

  async handleRequest(req, res) {
    this.applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      this.sendJson(req, res, 405, {
        ok: false,
        timestamp: Date.now(),
        error: 'Method not allowed'
      });
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (
      requestUrl.pathname === this.healthPath ||
      requestUrl.pathname === this.prefixedHealthPath ||
      requestUrl.pathname === this.livenessPath ||
      requestUrl.pathname === this.prefixedLivenessPath
    ) {
      const readiness = this.resolveStartupReadiness();
      this.sendJson(req, res, 200, {
        ok: true,
        ready: readiness.ready,
        phase: readiness.phase,
        timestamp: Date.now(),
        lastExporterUpdateAt: this.lastExporterUpdateAt,
        lastPlayerUpdateAt: this.lastPlayerUpdateAt,
        lastServerUpdateAt: this.lastServerUpdateAt
      });
      return;
    }

    if (
      requestUrl.pathname === this.readinessPath ||
      requestUrl.pathname === this.prefixedReadinessPath
    ) {
      const readiness = this.resolveStartupReadiness();
      this.sendJson(req, res, readiness.ready ? 200 : 503, {
        ok: readiness.ready,
        ready: readiness.ready,
        phase: readiness.phase,
        reasonCode: readiness.reasonCode,
        serverCode: this.resolveServerCode(),
        buildIdentity: this.buildIdentity,
        requiredPlugins: readiness.requiredPlugins,
        mountedPlugins: readiness.mountedPlugins,
        timestamp: Date.now()
      });
      return;
    }

    if (requestUrl.pathname === this.eventStreamPath) {
      this.openEventStream(req, res);
      return;
    }

    if (requestUrl.pathname === this.joinLinkPath) {
      const rateLimitState = this.checkRateLimit(req, 'join-link');
      if (rateLimitState.limited) {
        this.sendJson(
          req,
          res,
          429,
          {
            ok: false,
            timestamp: Date.now(),
            error: 'Rate limit exceeded'
          },
          {
            'Retry-After': String(Math.ceil(rateLimitState.retryAfterMs / 1000))
          }
        );
        return;
      }

      try {
        const joinLink = await this.requestJoinLink();
        if (!joinLink) {
          this.sendJson(req, res, 503, {
            ok: false,
            timestamp: Date.now(),
            error: 'Join link unavailable',
            serverId: this.resolveServerId(),
            serverCode: this.resolveServerCode(),
            serverName: this.resolveServerName()
          });
          return;
        }

        this.sendJson(req, res, 200, {
          ok: true,
          timestamp: Date.now(),
          serverId: this.resolveServerId(),
          serverCode: this.resolveServerCode(),
          serverName: this.resolveServerName(),
          joinLink
        });
      } catch (err) {
        this.verbose(1, `AutoseedExporter join-link request failed: ${err.message}`);
        this.sendJson(req, res, 502, {
          ok: false,
          timestamp: Date.now(),
          error: 'Join link lookup failed',
          serverId: this.resolveServerId(),
          serverCode: this.resolveServerCode(),
          serverName: this.resolveServerName()
        });
      }
      return;
    }

    if (requestUrl.pathname.startsWith(this.activitySessionsPath)) {
      const rateLimitState = this.checkRateLimit(req, 'activity-session');
      if (rateLimitState.limited) {
        this.sendJson(
          req,
          res,
          429,
          {
            ok: false,
            timestamp: Date.now(),
            error: 'Rate limit exceeded'
          },
          {
            'Retry-After': String(Math.ceil(rateLimitState.retryAfterMs / 1000))
          }
        );
        return;
      }

      let sessionId = '';
      try {
        sessionId = decodeURIComponent(requestUrl.pathname.slice(this.activitySessionsPath.length));
      } catch {
        sessionId = '';
      }
      if (!isPublicSessionId(sessionId)) {
        this.sendJson(req, res, 404, {
          ok: false,
          timestamp: Date.now(),
          error: 'Session not found'
        });
        return;
      }

      try {
        const detail = await this.buildActivitySessionDetail(sessionId);
        if (!detail) {
          this.sendJson(req, res, 404, {
            ok: false,
            timestamp: Date.now(),
            error: 'Session not found'
          });
          return;
        }
        this.sendJson(req, res, 200, detail);
      } catch (err) {
        this.verbose(1, `AutoseedExporter activity session lookup failed: ${err.message}`);
        this.sendJson(req, res, 503, {
          ok: false,
          timestamp: Date.now(),
          error: 'Session temporarily unavailable'
        });
      }
      return;
    }

    if (requestUrl.pathname === this.snapshotPath) {
      const rateLimitState = this.checkRateLimit(req, 'snapshot');
      if (rateLimitState.limited) {
        this.sendJson(
          req,
          res,
          429,
          {
            ok: false,
            timestamp: Date.now(),
            error: 'Rate limit exceeded'
          },
          {
            'Retry-After': String(Math.ceil(rateLimitState.retryAfterMs / 1000))
          }
        );
        return;
      }

      try {
        const snapshot = this.withCurrentReleaseWindow(await this.refreshSnapshot());
        this.sendJson(req, res, 200, snapshot);
      } catch (err) {
        this.verbose(1, `AutoseedExporter snapshot refresh failed: ${err.message}`);
        this.sendJson(req, res, 503, {
          ok: false,
          timestamp: Date.now(),
          error: 'Snapshot temporarily unavailable'
        });
      }
      return;
    }

    this.sendJson(req, res, 404, {
      ok: false,
      timestamp: Date.now(),
      error: 'Not found'
    });
  }
}
