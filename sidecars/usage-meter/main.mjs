/**
 * Antigravity Usage Meter — sidecar backend.
 *
 * Antigravity's local language server records, for every model generation, a
 * `contextWindowMetadata` object with the estimated context-window usage and
 * the model's maximum context size. This sidecar reads that data over the
 * language server's local Connect endpoint and serves it to the panel UI.
 *
 * The endpoint is internal to Antigravity. Everything is best-effort: if the
 * language server is unavailable, the panel shows a readable error instead of
 * failing the sidecar process.
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { SidecarApp, Response } from 'sidecar_sdk';
import { startHeaderWidget } from './header-widget.mjs';

const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const ENTRY_CACHE_TTL_MS = 2500;
const SUMMARY_CACHE_TTL_MS = 8000;
const QUOTA_CACHE_TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_HISTORY_POINTS = 48;

const app = new SidecarApp();

const entryCache = new Map(); // conversationId -> { entries, fetchedAt, pollsSinceFull, emptyStreak }
let summaryCache = { at: 0, data: [] };
let quotaCache = { at: 0, data: null };
let quotaInFlight = null;
let lastLoggedErrorAt = 0;
let resolvedProtocol = null;

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const readAsset = (name) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

app.page('/', () => readAsset('index.html'));
app.page('/app.js', () => readAsset('app.js'));
app.page('/styles.css', () => new Response(readAsset('styles.css'), { contentType: 'text/css; charset=utf-8' }));

// ---------------------------------------------------------------------------
// Language server transport
// ---------------------------------------------------------------------------

function parseAddress() {
  const raw = String(process.env.ANTIGRAVITY_LS_ADDRESS || 'localhost:5387').trim();
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      explicitProtocol: url.protocol.replace(':', ''),
    };
  }
  const lastColon = raw.lastIndexOf(':');
  if (lastColon > 0) {
    return {
      host: raw.slice(0, lastColon).replace(/^\[|\]$/g, ''),
      port: Number(raw.slice(lastColon + 1) || 5387),
      explicitProtocol: null,
    };
  }
  return { host: raw, port: 5387, explicitProtocol: null };
}

function isProtocolMismatch(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    code === 'EPROTO' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
    code === 'ERR_SSL_PACKET_LENGTH_MISMATCH' ||
    /wrong version number|ssl|tls|socket hang up|client sent an http request to an https server/i.test(message)
  );
}

function requestOnce(address, protocol, method, body) {
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const transport = protocol === 'https' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        host: address.host,
        port: address.port,
        path: SERVICE_PREFIX + method,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'x-codeium-csrf-token': process.env.ANTIGRAVITY_CSRF_TOKEN || '',
        },
      },
      (response) => {
        const chunks = [];
        let total = 0;

        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new Error(`Language server response too large (${method})`));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Language server HTTP ${response.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text || '{}'));
          } catch {
            reject(new Error(`Language server returned invalid JSON (${method})`));
          }
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(Object.assign(new Error('Language server timed out'), { code: 'ETIMEDOUT' }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function lsRpc(method, body) {
  const address = parseAddress();
  const candidates = address.explicitProtocol
    ? [address.explicitProtocol]
    : resolvedProtocol
      ? [resolvedProtocol]
      : ['https', 'http'];

  let lastError;
  for (const protocol of candidates) {
    try {
      const result = await requestOnce(address, protocol, method, body);
      resolvedProtocol = protocol;
      return result;
    } catch (error) {
      lastError = error;
      if (address.explicitProtocol || !isProtocolMismatch(error)) break;
    }
  }
  throw lastError;
}

function humanizeError(error) {
  const message = String(error?.message || error || 'Unknown error');
  const code = String(error?.code || '');

  if (code === 'ECONNREFUSED') {
    return 'Could not connect to the Antigravity language server (connection refused). Is Antigravity running?';
  }
  if (code === 'ETIMEDOUT' || /timed out/i.test(message)) {
    return 'The Antigravity language server did not respond in time.';
  }
  if (code === 'EPROTO' || /ssl|tls|wrong version/i.test(message)) {
    return 'Could not establish a secure connection to the language server.';
  }
  if (/trajectory not found/i.test(message)) {
    return 'Conversation not found. It may have been deleted or not loaded yet.';
  }
  return message;
}

function logError(error) {
  const now = Date.now();
  if (now - lastLoggedErrorAt > 30000) {
    lastLoggedErrorAt = now;
    console.error('[usage-meter]', error?.stack || error?.message || error);
  }
}

// ---------------------------------------------------------------------------
// Data normalization
// ---------------------------------------------------------------------------

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : '';
}

function parseDurationSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = /^([\d.]+)s$/.exec(String(value || '').trim());
  return match ? Number(match[1]) : null;
}

function maxStepIndex(entry) {
  const indices = Array.isArray(entry?.stepIndices) ? entry.stepIndices.map(toNumber) : [];
  return indices.length ? Math.max(...indices) : -1;
}

function downsample(points, limit) {
  if (points.length <= limit) return points;
  const result = [];
  const stride = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    result.push(points[Math.round(index * stride)]);
  }
  result[0] = points[0];
  result[result.length - 1] = points[points.length - 1];
  return result;
}

function summarizeConversation(summary, id) {
  return {
    id,
    title: summary?.title || summary?.summary || 'Untitled conversation',
    stepCount: toNumber(summary?.stepCount),
    lastModifiedTime: summary?.lastModifiedTime || summary?.createdTime || null,
    status: summary?.status || '',
    projectId: summary?.projectId || summary?.trajectoryMetadata?.projectId || '',
    trajectoryId: summary?.trajectoryId || '',
    parentConversationId: summary?.parentConversationId || '',
    nestingDepth: toNumber(summary?.nestingDepth),
  };
}

function publicSummary(summary) {
  return {
    id: summary.id,
    title: summary.title,
    stepCount: summary.stepCount,
    lastModifiedTime: summary.lastModifiedTime,
    status: summary.status,
    projectId: summary.projectId,
    trajectoryId: summary.trajectoryId,
  };
}

// ---------------------------------------------------------------------------
// Language server queries
// ---------------------------------------------------------------------------

async function getSummaries(force = false) {
  if (!force && summaryCache.at && Date.now() - summaryCache.at < SUMMARY_CACHE_TTL_MS) {
    return summaryCache.data;
  }

  const response = await lsRpc('GetAllCascadeTrajectories', {});
  const map = response?.trajectorySummaries || {};
  const all = Object.entries(map).map(([id, value]) => {
    const annotations = value?.annotations || {};
    return summarizeConversation(
      {
        ...value,
        title: annotations.title || value?.title,
        summary: value?.summary,
        projectId: value?.trajectoryMetadata?.projectId,
      },
      id
    );
  });

  const roots = all.filter((item) => !item.parentConversationId && !item.nestingDepth);
  const sorted = (roots.length ? roots : all).sort((a, b) => {
    const left = new Date(a.lastModifiedTime || 0).getTime();
    const right = new Date(b.lastModifiedTime || 0).getTime();
    return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
  });

  summaryCache = { at: Date.now(), data: sorted };
  return sorted;
}

function windowAbbrev(windowValue) {
  const value = String(windowValue || '').toLowerCase();
  if (value.includes('5') && value.includes('hour')) return '5h';
  if (value.includes('week') || value.includes('7d')) return '7d';
  if (value.includes('month') || value.includes('30d')) return '30d';
  if (value.includes('day') || value.includes('24h')) return '24h';
  return value ? value.slice(0, 4) : '—';
}

function windowTitle(windowValue) {
  const value = String(windowValue || '').toLowerCase();
  if (value.includes('week')) return 'Weekly limit';
  if (value.includes('5') && value.includes('hour')) return '5-hour limit';
  if (value.includes('month')) return 'Monthly limit';
  if (value.includes('day')) return 'Daily limit';
  return 'Usage limit';
}

function normalizeQuota(payload) {
  const raw = payload?.response || payload || {};
  const groups = Array.isArray(raw.groups) ? raw.groups : [];

  return {
    description: raw.description || '',
    groups: groups.map((group) => ({
      name: group.displayName || 'Usage group',
      description: group.description || '',
      buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((bucket) => {
        const fraction = Math.max(0, Math.min(1, toNumber(bucket.remainingFraction)));
        return {
          id: bucket.bucketId || '',
          name: bucket.displayName || 'Limit',
          window: bucket.window || '',
          windowAbbrev: windowAbbrev(bucket.window),
          windowTitle: windowTitle(bucket.window),
          remainingFraction: fraction,
          remainingPercent: Math.round(fraction * 1000) / 10,
          resetTime: bucket.resetTime || null,
          description: bucket.description || '',
        };
      }),
    })),
    fetchedAt: new Date().toISOString(),
  };
}

async function getQuota(force = false) {
  if (!force && quotaCache.at && Date.now() - quotaCache.at < QUOTA_CACHE_TTL_MS) {
    return quotaCache.data;
  }
  if (quotaInFlight) return quotaInFlight;

  quotaInFlight = (async () => {
    const response = await lsRpc('RetrieveUserQuotaSummary', {});
    if (response?.code && response?.message && !response.response) {
      throw new Error(response.message);
    }
    const quota = normalizeQuota(response);
    quotaCache = { at: Date.now(), data: quota };
    return quota;
  })();

  try {
    return await quotaInFlight;
  } finally {
    quotaInFlight = null;
  }
}

async function getEntries(conversationId, forceFull = false) {
  const now = Date.now();
  let state = entryCache.get(conversationId);
  if (!state) {
    state = { entries: [], fetchedAt: 0, pollsSinceFull: 0, emptyStreak: 0 };
  }

  if (!forceFull && state.fetchedAt && now - state.fetchedAt < ENTRY_CACHE_TTL_MS) {
    return state;
  }

  let full = forceFull || state.entries.length === 0 || state.pollsSinceFull >= 10 || state.emptyStreak >= 2;
  const offset = full ? 0 : Math.max(0, state.entries.length - 1);

  let response;
  try {
    response = await lsRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascade_id: conversationId,
      generator_metadata_offset: offset,
    });
  } catch (error) {
    if (!full) {
      // An incremental offset can be rejected after a conversation is rewound.
      // Fall back to a full read once before surfacing the error.
      response = await lsRpc('GetCascadeTrajectoryGeneratorMetadata', { cascade_id: conversationId });
      state.entries = [];
      full = true;
    } else {
      throw error;
    }
  }

  const incoming = Array.isArray(response?.generatorMetadata) ? response.generatorMetadata : [];

  if (response?.code && response?.message && !incoming.length) {
    throw new Error(response.message);
  }

  if (full || !state.entries.length) {
    state.entries = incoming;
  } else if (incoming.length) {
    state.entries = state.entries.slice(0, offset).concat(incoming);
  }

  state.emptyStreak = incoming.length ? 0 : state.emptyStreak + 1;
  state.fetchedAt = now;
  state.pollsSinceFull = full ? 0 : state.pollsSinceFull + 1;
  entryCache.set(conversationId, state);
  return state;
}

function buildContext(entries) {
  const points = [];

  for (const entry of entries) {
    const chatModel = entry?.chatModel || {};
    const metadata = chatModel.chatStartMetadata?.contextWindowMetadata;
    if (!metadata) continue;

    const used = toNumber(metadata.estimatedTokensUsed);
    const max = toNumber(metadata.maxContextTokens);
    if (!(used >= 0) || !(max > 0)) continue;

    points.push({
      step: maxStepIndex(entry),
      used,
      max,
      model: chatModel.modelDisplayName || chatModel.responseModel || '',
    });
  }

  if (!points.length) return null;

  let latestEntry = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const chatModel = entries[index]?.chatModel;
    const metadata = chatModel?.chatStartMetadata?.contextWindowMetadata;
    if (metadata && toNumber(metadata.maxContextTokens) > 0) {
      latestEntry = entries[index];
      break;
    }
  }

  const chatModel = latestEntry?.chatModel || {};
  const usage = chatModel.usage || {};
  const latestPoint = points[points.length - 1];
  const used = latestPoint.used;
  const max = latestPoint.max;

  const input = toNumber(usage.inputTokens);
  const output = toNumber(usage.outputTokens);
  const thinking = toNumber(usage.thinkingOutputTokens);

  return {
    used,
    max,
    percent: Math.round((used / max) * 10000) / 100,
    remaining: Math.max(0, max - used),
    model: chatModel.modelDisplayName || latestPoint.model || 'Unknown model',
    responseModel: chatModel.responseModel || '',
    step: latestPoint.step,
    generationCount: points.length,
    checkpointIndex: toNumber(chatModel.chatStartMetadata?.checkpointIndex),
    usage: {
      input,
      output,
      thinking,
      total: input + output + thinking,
    },
    timeToFirstTokenSec: parseDurationSeconds(chatModel.timeToFirstToken),
    history: downsample(points, MAX_HISTORY_POINTS).map((point) => ({
      step: point.step,
      used: point.used,
      max: point.max,
    })),
  };
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

async function contextHandler(input = {}) {
  let summaries = [];
  let summaryError = null;

  try {
    summaries = await getSummaries();
  } catch (error) {
    summaryError = humanizeError(error);
    logError(error);
  }

  let quota = null;
  let quotaError = null;
  try {
    quota = await getQuota();
  } catch (error) {
    quotaError = humanizeError(error);
    logError(error);
  }

  const explicitId = normalizeId(input.conversationId);
  const environmentId = normalizeId(process.env.ANTIGRAVITY_CONVERSATION_ID);
  const conversationId = explicitId || environmentId || summaries[0]?.id || '';
  const selected = explicitId ? 'explicit' : environmentId ? 'environment' : 'recent';
  const conversations = summaries.slice(0, 12).map(publicSummary);

  if (!conversationId) {
    return {
      ok: true,
      context: null,
      reason: 'no-conversation',
      conversations,
      quota,
      quotaError,
      warning: summaryError,
    };
  }

  const summary = summaries.find((item) => item.id === conversationId);
  const conversation = summary
    ? { ...publicSummary(summary), selected }
    : { id: conversationId, title: 'Conversation', selected };

  try {
    const state = await getEntries(conversationId, Boolean(input.full));
    const context = buildContext(state.entries);

    if (!context) {
      return {
        ok: true,
        context: null,
        reason: 'no-generations',
        conversation,
        conversations,
        quota,
        quotaError,
        warning: summaryError,
      };
    }

    return {
      ok: true,
      context,
      conversation,
      conversations,
      quota,
      quotaError,
      fetchedAt: new Date().toISOString(),
      warning: summaryError,
    };
  } catch (error) {
    logError(error);
    return {
      ok: false,
      code: 'LANGUAGE_SERVER_ERROR',
      error: humanizeError(error),
      conversation,
      conversations,
      quota,
      quotaError,
    };
  }
}

app.api('/api/context', contextHandler);

app.api('/api/conversations', async () => {
  try {
    const summaries = await getSummaries(true);
    return { ok: true, conversations: summaries.slice(0, 12).map(publicSummary) };
  } catch (error) {
    logError(error);
    return { ok: false, error: humanizeError(error) };
  }
});

app.api(
  '/healthz',
  () => ({
    ok: true,
    service: 'usage-meter',
    version: '1.0.0',
    lsAddress: `${parseAddress().host}:${parseAddress().port}`,
    cachedConversations: entryCache.size,
  }),
  'GET'
);

const address = parseAddress();
console.log(
  `[usage-meter] starting - language server ${address.host}:${address.port}, ` +
    `conversation ${process.env.ANTIGRAVITY_CONVERSATION_ID ? 'bound' : 'not bound'}`
);

app.run()
  .then(() => {
    startHeaderWidget({
      getContext: async (conversationId) => {
        const state = await getEntries(conversationId, false);
        return buildContext(state.entries);
      },
      getQuota: async () => {
        try {
          return await getQuota();
        } catch {
          return null;
        }
      },
    });
  })
  .catch((error) => {
    console.error('[usage-meter] failed to start:', error);
    process.exit(1);
  });
