/**
 * Header widget for the Context Meter.
 *
 * Antigravity does not expose a chat-header extension point, so this module
 * injects a small, fixed-position pill into the running app's renderer over its
 * local Chrome DevTools Protocol endpoint. The pill sits immediately left of
 * the "Open IDE" button and shows the live context-window usage for the
 * conversation in the current URL (`/c/<conversationId>`).
 *
 * This is an unofficial, best-effort integration:
 *  - If CDP is unavailable, the sidecar panel still works.
 *  - The widget is re-injected automatically if the app re-renders or reloads.
 *  - Set CONTEXT_METER_HEADER=0 in sidecar.json env to disable it.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const POLL_INTERVAL_MS = 4000;
const COMMAND_TIMEOUT_MS = 3500;
const WIDGET_ID = 'agcm-header';
const WIDGET_VERSION = '9';
const RING_CIRCUMFERENCE = 94.25;

const DEVTOOLS_FILE_CANDIDATES = [
  process.env.APPDATA ? path.join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort') : '',
  path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
  path.join(os.homedir(), '.config', 'Antigravity', 'DevToolsActivePort'),
].filter(Boolean);

const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percentFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function readDevToolsPort() {
  for (const file of DEVTOOLS_FILE_CANDIDATES) {
    try {
      const [portLine] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Try the next platform-specific location.
    }
  }
  return 0;
}

function httpJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: requestPath, timeout: 2500 },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`CDP HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error('CDP returned invalid JSON'));
          }
        });
      }
    );
    request.setTimeout(2500, () => request.destroy(new Error('CDP HTTP timeout')));
    request.on('error', reject);
  });
}

function pickAppPage(pages) {
  const pageTargets = (Array.isArray(pages) ? pages : []).filter(
    (page) => page && page.type === 'page' && page.webSocketDebuggerUrl
  );

  const appPages = pageTargets.filter((page) =>
    /^https:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(String(page.url || ''))
  );
  const chatPages = appPages.filter((page) =>
    /\/c\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}/.test(String(page.url || ''))
  );
  const titledPages = pageTargets.filter((page) =>
    /antigravity/i.test(String(page.title || ''))
  );

  return chatPages[0] || appPages[0] || titledPages[0] || null;
}

function conversationIdFromUrl(url) {
  const match = /\/c\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/.exec(String(url || ''));
  return match ? match[1] : '';
}

function formatReset(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 'reset time unavailable';
  const remainingMs = date.getTime() - Date.now();
  if (remainingMs <= 0) return 'resetting now';
  const totalMinutes = Math.floor(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

function usageColor(fraction) {
  const value = Number(fraction) || 0;
  return value >= 0.5 ? '#34d399' : value >= 0.2 ? '#f59e0b' : '#f87171';
}

function pickPrimaryGroup(quota, model) {
  const groups = quota?.groups || [];
  if (!groups.length) return null;
  const modelName = String(model || '').toLowerCase();
  const match = groups.find((group) => {
    const groupName = String(group.name || '').toLowerCase();
    if (modelName.includes('gemini')) return groupName.includes('gemini');
    if (modelName.includes('claude') || modelName.includes('gpt')) {
      return groupName.includes('claude') || groupName.includes('gpt');
    }
    return false;
  });
  return match || groups[0];
}

function widgetData(context, quota) {
  const percent = Number(context.percent) || 0;
  const color = percent >= 90 ? '#f87171' : percent >= 70 ? '#f59e0b' : '#34d399';
  const percentText = `${percentFormatter.format(percent)}%`;
  const tokenText = `${compactFormatter.format(context.used)} / ${compactFormatter.format(context.max)}`;

  const primaryGroup = pickPrimaryGroup(quota, context.model);
  const weeklyBucket =
    primaryGroup?.buckets?.find((bucket) => /week|7d/i.test(`${bucket.window} ${bucket.windowAbbrev}`)) ||
    primaryGroup?.buckets?.[0];
  const weeklyColor = weeklyBucket ? usageColor(weeklyBucket.remainingFraction) : '';

  const tooltip = [
    context.model || 'Unknown model',
    `${intFormatter.format(context.used)} / ${intFormatter.format(context.max)} tokens`,
    `${percentText} used`,
  ];

  if (quota?.groups?.length) {
    tooltip.push('', 'Usage limits');
    for (const group of quota.groups) {
      for (const bucket of group.buckets) {
        tooltip.push(
          `${group.name} · ${bucket.windowTitle || bucket.windowAbbrev}: ` +
            `${percentFormatter.format(bucket.remainingPercent)}% left · ${formatReset(bucket.resetTime)}`
        );
      }
    }
  }

  tooltip.push('Click to open or close the Context Meter panel.');

  return {
    percent,
    percentText,
    detailPrefix: weeklyBucket ? weeklyBucket.windowAbbrev : tokenText,
    detailValue: weeklyBucket ? `${percentFormatter.format(weeklyBucket.remainingPercent)}%` : '',
    detailSuffix: weeklyBucket ? 'left' : '',
    detailColor: weeklyBucket ? weeklyColor : '',
    color,
    tooltip: tooltip.join('\n'),
    label: 'Context',
  };
}

function widgetScript(data) {
  const payload = JSON.stringify(data);

  return `(() => {
    const DATA = ${payload};
    const ID = '${WIDGET_ID}';
    const VERSION = '${WIDGET_VERSION}';
    const CIRC = ${RING_CIRCUMFERENCE};

    const existing = document.getElementById(ID);
    if (existing && existing.dataset.agcmVersion === VERSION && typeof window.__agcmRender === 'function') {
      window.__agcmRender(DATA);
      return 'updated';
    }
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = ID;
    host.dataset.agcmVersion = VERSION;
    host.style.cssText = [
      'position:relative',
      'flex:0 0 auto',
      'height:28px',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:0 10px',
      'border-radius:9px',
      'background:rgba(255,255,255,.055)',
      'border:1px solid rgba(255,255,255,.12)',
      'color:#d4d4d4',
      'font:12px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'z-index:1',
      'box-shadow:0 1px 2px rgba(0,0,0,.3)',
      'backdrop-filter:blur(8px)',
      'cursor:pointer',
      'user-select:none',
      'white-space:nowrap',
      'transition:background .15s ease,border-color .15s ease'
    ].join(';');

    host.innerHTML = [
      '<svg width="16" height="16" viewBox="0 0 36 36" style="flex:0 0 auto" aria-hidden="true">',
      '  <circle data-agcm="track" cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="4"></circle>',
      '  <circle data-agcm="ring" cx="18" cy="18" r="15" fill="none" stroke="#34d399" stroke-width="4"',
      '    stroke-linecap="round" stroke-dasharray="' + CIRC + '" stroke-dashoffset="' + CIRC + '"',
      '    transform="rotate(-90 18 18)"></circle>',
      '</svg>',
      '<span data-agcm="label" style="color:#9ca3af">Context</span>',
      '<span data-agcm="pct" style="font-weight:600;color:#e5e7eb">%—</span>',
      '<span data-agcm="sep" style="color:#6b7280">·</span>',
      '<span data-agcm="detail" style="display:inline-flex;align-items:baseline;gap:4px;color:#9ca3af">',
      '  <span data-agcm="detail-prefix"></span>',
      '  <span data-agcm="detail-value" style="font-weight:700;font-size:13px;color:#e5e7eb"></span>',
      '  <span data-agcm="detail-suffix"></span>',
      '</span>'
    ].join('');

    document.body.appendChild(host);

    const track = host.querySelector('[data-agcm="track"]');
    const ring = host.querySelector('[data-agcm="ring"]');
    const pct = host.querySelector('[data-agcm="pct"]');
    const detail = host.querySelector('[data-agcm="detail"]');
    const detailPrefix = host.querySelector('[data-agcm="detail-prefix"]');
    const detailValue = host.querySelector('[data-agcm="detail-value"]');
    const detailSuffix = host.querySelector('[data-agcm="detail-suffix"]');
    const label = host.querySelector('[data-agcm="label"]');
    const sep = host.querySelector('[data-agcm="sep"]');

    host.setAttribute('role', 'button');
    host.setAttribute('tabindex', '0');
    host.setAttribute('aria-label', 'Toggle the Context Meter panel');

    const isDarkMode = () =>
      document.body.classList.contains('dark') ||
      document.documentElement.classList.contains('dark');
    const baseBackground = () =>
      isDarkMode() ? 'rgba(255,255,255,.055)' : 'rgba(0,0,0,.035)';
    const hoverBackground = () =>
      isDarkMode() ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.06)';

    const toggleAuxPane = () => {
      const shell = document.querySelector('.agy-shell');
      const auxWidth = shell
        ? parseFloat(getComputedStyle(shell).getPropertyValue('--aux-pane-width')) || 0
        : 0;
      const toggle = document.querySelector('button[aria-label="Toggle Auxiliary Pane"]');
      if (!toggle) return;

      if (auxWidth > 0) {
        toggle.click();
        return;
      }

      toggle.click();
      setTimeout(() => {
        const tabs = [...document.querySelectorAll('button[title="Context Meter"]')];
        const tab = tabs.find((el) => el.getBoundingClientRect().width > 0) || tabs[0];
        if (tab) tab.click();
      }, 600);
    };

    host.addEventListener('mouseenter', () => {
      host.style.background = hoverBackground();
    });
    host.addEventListener('mouseleave', () => {
      host.style.background = baseBackground();
    });
    host.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleAuxPane();
    });
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        toggleAuxPane();
      }
    });
    window.__agcmRender = (d) => {
      const el = document.getElementById(ID);
      if (!el) return;
      if (!d || d.hidden || window.innerWidth < 960) {
        el.style.display = 'none';
        return;
      }

      const more = document.querySelector('button[aria-label="More actions"]');
      const openIde = [...document.querySelectorAll('button')].find(
        (button) => (button.textContent || '').trim() === 'Open IDE'
      );
      const group = (more && more.parentElement) || (openIde && openIde.parentElement);

      if (!group) {
        el.style.display = 'none';
        return;
      }
      if (el.parentElement !== group) {
        group.insertBefore(el, group.firstChild);
      }

      el.style.display = 'flex';

      const dark =
        document.body.classList.contains('dark') ||
        document.documentElement.classList.contains('dark');
      el.style.background = dark ? 'rgba(255,255,255,.055)' : 'rgba(0,0,0,.035)';
      el.style.borderColor = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.12)';
      el.style.color = dark ? '#d4d4d4' : '#333333';
      el.style.boxShadow = dark ? '0 1px 2px rgba(0,0,0,.3)' : '0 1px 2px rgba(0,0,0,.08)';
      track.style.stroke = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)';
      label.style.color = dark ? '#9ca3af' : '#6b7280';
      detail.style.color = dark ? '#9ca3af' : '#6b7280';
      sep.style.color = dark ? '#6b7280' : '#d1d5db';

      const clamped = Math.max(0, Math.min(100, Number(d.percent) || 0));
      ring.style.stroke = d.color;
      ring.style.strokeDashoffset = String(CIRC * (1 - clamped / 100));
      pct.textContent = d.percentText;
      pct.style.color = d.color;
      detailPrefix.textContent = d.detailPrefix || '';
      detailValue.textContent = d.detailValue || '';
      detailSuffix.textContent = d.detailSuffix || '';
      detailValue.style.display = d.detailValue ? 'inline' : 'none';
      detailSuffix.style.display = d.detailSuffix ? 'inline' : 'none';
      detailValue.style.color = d.detailColor || (dark ? '#e5e7eb' : '#111827');
      label.textContent = d.label || 'Context';
      el.title = d.tooltip || '';
    };

    window.__agcmRender(DATA);

    if (!window.__agcmGuard) {
      window.__agcmGuard = setInterval(() => {
        const current = document.getElementById(ID);
        if (!current || !current.isConnected) return;
        const more = document.querySelector('button[aria-label="More actions"]');
        const openIde = [...document.querySelectorAll('button')].find(
          (button) => (button.textContent || '').trim() === 'Open IDE'
        );
        const group = (more && more.parentElement) || (openIde && openIde.parentElement);
        if (group && current.parentElement !== group) {
          group.insertBefore(current, group.firstChild);
        }
      }, 500);
    }

    return 'injected';
  })()`;
}

export function startHeaderWidget({ getContext, getQuota, log = console } = {}) {
  if (typeof getContext !== 'function') return { stop() {} };
  if (String(process.env.CONTEXT_METER_HEADER || '1').toLowerCase() === '0' ||
      String(process.env.CONTEXT_METER_HEADER || '1').toLowerCase() === 'false') {
    log.log('[context-meter] header widget disabled');
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let socket = null;
  let socketUrl = '';
  let socketPromise = null;
  let sequence = 0;
  const pending = new Map();
  let lastErrorAt = 0;
  let lastConversationId = '';
  let lastContext = null;
  let lastQuota = null;

  function logError(message, error) {
    const now = Date.now();
    if (now - lastErrorAt > 30000) {
      lastErrorAt = now;
      log.warn('[context-meter] header widget:', message, error?.message || error || '');
    }
  }

  function closeSocket() {
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore close errors.
      }
    }
    socket = null;
    socketUrl = '';
    socketPromise = null;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP socket closed'));
    }
    pending.clear();
  }

  async function ensureSocket(wsUrl) {
    if (socket && socketUrl === wsUrl && socket.readyState === 1) return;
    if (socket && socketUrl === wsUrl && socket.readyState === 0 && socketPromise) {
      return socketPromise;
    }

    closeSocket();
    socketUrl = wsUrl;
    socket = new WebSocket(wsUrl);

    socketPromise = new Promise((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        socket.removeEventListener('open', onOpen);
        reject(new Error('CDP WebSocket error'));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
      else entry.resolve(message.result);
    });

    socket.addEventListener('close', () => {
      socket = null;
      socketUrl = '';
      socketPromise = null;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP socket closed'));
      }
      pending.clear();
    });

    socket.addEventListener('error', () => {
      // The close event handles rejection and cleanup.
    });

    return socketPromise;
  }

  async function evaluate(wsUrl, expression) {
    await ensureSocket(wsUrl);
    if (!socket) throw new Error('CDP socket is not available');

    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP evaluate timed out'));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, entry);
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        })
      );
    });
  }

  async function tick() {
    if (stopped) return;

    try {
      const port = readDevToolsPort();
      if (!port) return;

      const pages = await httpJson(port, '/json/list');
      const page = pickAppPage(pages);
      if (!page) return;

      const conversationId = conversationIdFromUrl(page.url);

      if (!conversationId) {
        lastConversationId = '';
        lastContext = null;
        await evaluate(page.webSocketDebuggerUrl, widgetScript({ hidden: true }));
        return;
      }

      if (conversationId !== lastConversationId) {
        lastConversationId = conversationId;
        lastContext = null;
      }

      let context = null;
      try {
        context = await getContext(conversationId);
      } catch (error) {
        logError('context fetch failed', error);
      }

      if (context) {
        lastContext = context;
      } else if (!lastContext) {
        await evaluate(page.webSocketDebuggerUrl, widgetScript({ hidden: true }));
        return;
      }

      let quota = null;
      if (typeof getQuota === 'function') {
        try {
          quota = await getQuota();
        } catch {
          // Keep the last known quota on transient failures.
        }
      }
      if (quota) lastQuota = quota;

      await evaluate(page.webSocketDebuggerUrl, widgetScript(widgetData(lastContext, lastQuota)));
    } catch (error) {
      logError('tick failed', error);
      if (socket && socket.readyState !== 1) closeSocket();
    } finally {
      schedule();
    }
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  log.log('[context-meter] header widget enabled');
  timer = setTimeout(tick, 1800);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      closeSocket();
    },
  };
}
