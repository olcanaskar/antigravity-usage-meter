(() => {
  'use strict';

  const REFRESH_INTERVAL_MS = 4000;
  const OK_COLOR = '#34d399';
  const WARN_COLOR = '#f59e0b';
  const DANGER_COLOR = '#f87171';
  const IDLE_COLOR = '#94a3b8';

  const params = new URLSearchParams(window.location.search);
  const initialConversationId =
    (window.sidecar && window.sidecar.conversationId) || params.get('conversationId') || '';

  const els = {
    statusDot: document.getElementById('status-dot'),
    model: document.getElementById('model'),
    refresh: document.getElementById('refresh'),
    conversationRow: document.getElementById('conversation-row'),
    conversationSelect: document.getElementById('conversation-select'),
    binding: document.getElementById('binding'),
    banner: document.getElementById('banner'),
    content: document.getElementById('content'),
    gaugeFill: document.getElementById('gauge-fill'),
    percent: document.getElementById('percent'),
    used: document.getElementById('used'),
    remaining: document.getElementById('remaining'),
    progress: document.getElementById('progress'),
    barFill: document.getElementById('bar-fill'),
    capacity: document.getElementById('capacity'),
    capacityNote: document.getElementById('capacity-note'),
    usageInput: document.getElementById('usage-input'),
    usageOutput: document.getElementById('usage-output'),
    usageThinking: document.getElementById('usage-thinking'),
    step: document.getElementById('step'),
    generationCount: document.getElementById('generation-count'),
    historyMeta: document.getElementById('history-meta'),
    sparkline: document.getElementById('sparkline'),
    usage: document.getElementById('usage'),
    usageMeta: document.getElementById('usage-meta'),
    conversationTitle: document.getElementById('conversation-title'),
    updated: document.getElementById('updated'),
    state: document.getElementById('state'),
    stateIcon: document.getElementById('state-icon'),
    stateTitle: document.getElementById('state-title'),
    stateMessage: document.getElementById('state-message'),
    stateRetry: document.getElementById('state-retry'),
  };

  const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const percentFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  let currentConversationId = initialConversationId;
  let currentData = null;
  let inFlight = false;
  let requestSeq = 0;
  let timer = null;
  let lastHistory = null;
  let lastHistoryColor = OK_COLOR;
  let lastConversationSignature = '';
  let resizeFrame = 0;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function api(path, body) {
    const fetcher =
      window.sidecar && typeof window.sidecar.fetch === 'function'
        ? window.sidecar.fetch.bind(window.sidecar)
        : window.fetch.bind(window);

    return fetcher(path, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      return response.json();
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatInt(value) {
    const number = Number(value);
    return intFormatter.format(Number.isFinite(number) ? Math.round(number) : 0);
  }

  function formatPercent(value) {
    const number = Number(value);
    return `${percentFormatter.format(Number.isFinite(number) ? number : 0)}%`;
  }

  function formatCompact(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    try {
      return new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(number);
    } catch {
      return formatInt(number);
    }
  }

  function formatTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '–';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function shortId(value) {
    return String(value || '').slice(0, 8);
  }

  function formatReset(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Reset time unavailable';
    const remainingMs = date.getTime() - Date.now();
    if (remainingMs <= 0) return 'Resetting now';
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
    return value >= 0.5 ? OK_COLOR : value >= 0.2 ? WARN_COLOR : DANGER_COLOR;
  }

  function setAccentColor(color) {
    document.documentElement.style.setProperty('--accent-color', color);
  }

  function setStatus(kind) {
    const colors = {
      ok: OK_COLOR,
      warn: WARN_COLOR,
      danger: DANGER_COLOR,
      error: DANGER_COLOR,
      idle: IDLE_COLOR,
    };
    const labels = {
      ok: 'Context usage normal',
      warn: 'Context usage elevated',
      danger: 'Context nearly full',
      error: 'Connection error',
      idle: 'Idle',
    };
    els.statusDot.style.background = colors[kind] || IDLE_COLOR;
    els.statusDot.setAttribute('aria-label', labels[kind] || labels.idle);
  }

  function setSpinning(spinning) {
    els.refresh.classList.toggle('spinning', Boolean(spinning));
    els.refresh.disabled = Boolean(spinning);
  }

  function showState({ spinner = false, icon = '!', title, message, retry = false }) {
    els.content.classList.add('hidden');
    els.state.classList.remove('hidden');
    els.stateIcon.innerHTML = spinner ? '<div class="spinner"></div>' : '';
    if (!spinner) els.stateIcon.textContent = icon;
    els.stateTitle.textContent = title;
    els.stateMessage.textContent = message;
    els.stateRetry.classList.toggle('hidden', !retry);
  }

  function hideState() {
    els.state.classList.add('hidden');
    els.content.classList.remove('hidden');
  }

  function setBinding(message) {
    if (!message) {
      els.binding.className = 'banner info hidden';
      els.binding.textContent = '';
      return;
    }
    els.binding.className = 'banner info';
    els.binding.textContent = message;
  }

  // -------------------------------------------------------------------------
  // Sparkline
  // -------------------------------------------------------------------------

  function renderSparkline(history, color) {
    lastHistory = Array.isArray(history) ? history : [];
    lastHistoryColor = color || OK_COLOR;

    const container = els.sparkline;
    if (lastHistory.length < 2) {
      container.innerHTML = '<div class="spark-empty">Not enough data yet.</div>';
      return;
    }

    const width = Math.max(240, Math.round(container.clientWidth || 320));
    const height = 86;
    const pad = { top: 10, right: 6, bottom: 16, left: 6 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const maxUsed = Math.max(...lastHistory.map((point) => Number(point.used) || 0), 1);
    const domainMax = maxUsed * 1.08;

    const x = (index) =>
      pad.left + (lastHistory.length === 1 ? plotWidth / 2 : (index / (lastHistory.length - 1)) * plotWidth);
    const y = (value) => pad.top + (1 - (Number(value) || 0) / domainMax) * plotHeight;

    const linePath = lastHistory
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.used).toFixed(1)}`)
      .join(' ');
    const baseline = (pad.top + plotHeight).toFixed(1);
    const areaPath = `${linePath} L${x(lastHistory.length - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`;

    const grid = [0, 0.5, 1]
      .map((fraction) => {
        const gridY = (pad.top + plotHeight * fraction).toFixed(1);
        return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gridY}" y2="${gridY}"
          stroke="currentColor" stroke-opacity="0.08" stroke-dasharray="3 4" />`;
      })
      .join('');

    const lastIndex = lastHistory.length - 1;
    const lastPoint = lastHistory[lastIndex];

    const svg = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="cm-spark-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${lastHistoryColor}" stop-opacity="0.3"></stop>
            <stop offset="100%" stop-color="${lastHistoryColor}" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${areaPath}" fill="url(#cm-spark-gradient)"></path>
        <path d="${linePath}" fill="none" stroke="${lastHistoryColor}" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"></path>
        <circle cx="${x(lastIndex).toFixed(1)}" cy="${y(lastPoint.used).toFixed(1)}" r="6"
          fill="${lastHistoryColor}" fill-opacity="0.16"></circle>
        <circle cx="${x(lastIndex).toFixed(1)}" cy="${y(lastPoint.used).toFixed(1)}" r="3.2"
          fill="${lastHistoryColor}"></circle>
        <text x="${width - pad.right}" y="8" text-anchor="end" fill="currentColor" fill-opacity="0.45"
          font-size="9">${formatCompact(maxUsed)}</text>
        <text x="${pad.left}" y="${height - 3}" fill="currentColor" fill-opacity="0.45"
          font-size="9">0</text>
        <rect data-hit="1" x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${plotHeight}"
          fill="transparent"></rect>
      </svg>
      <div class="spark-tip" id="spark-tip"></div>
    `;

    container.innerHTML = svg;

    const svgElement = container.querySelector('svg');
    const hitArea = container.querySelector('[data-hit]');
    const tip = container.querySelector('.spark-tip');
    if (!svgElement || !hitArea || !tip) return;

    hitArea.addEventListener('pointermove', (event) => {
      const rect = svgElement.getBoundingClientRect();
      const pointerX = ((event.clientX - rect.left) / rect.width) * width;
      let nearest = 0;
      let bestDistance = Infinity;

      lastHistory.forEach((point, index) => {
        const distance = Math.abs(x(index) - pointerX);
        if (distance < bestDistance) {
          bestDistance = distance;
          nearest = index;
        }
      });

      const point = lastHistory[nearest];
      const stepLabel = Number(point.step) >= 0 ? `Step ${formatInt(point.step)}` : `Generation ${nearest + 1}`;
      tip.textContent = `${stepLabel} · ${formatInt(point.used)} tokens`;
      tip.style.left = `${(x(nearest) / width) * 100}%`;
      tip.style.top = `${(y(point.used) / height) * 100}%`;
      tip.classList.add('visible');
    });

    hitArea.addEventListener('pointerleave', () => {
      tip.classList.remove('visible');
    });
  }

  // -------------------------------------------------------------------------
  // Conversation picker
  // -------------------------------------------------------------------------

  function updateConversationOptions(list, activeId) {
    const items = (Array.isArray(list) ? list : []).filter((item) => item && item.id);
    const active = currentConversationId || activeId || '';
    const activeIsListed = items.some((item) => item.id === active);

    if (items.length <= 1 && (!active || activeIsListed)) {
      els.conversationRow.classList.add('hidden');
      return;
    }

    els.conversationRow.classList.remove('hidden');
    const signature = `${items.map((item) => item.id).join('|')}#${active && !activeIsListed ? active : ''}`;

    if (signature !== lastConversationSignature) {
      els.conversationSelect.innerHTML = '';
      for (const item of items) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.title || shortId(item.id);
        option.title = `${item.title || item.id} · ${formatInt(item.stepCount)} steps`;
        els.conversationSelect.append(option);
      }
      if (active && !activeIsListed) {
        const option = document.createElement('option');
        option.value = active;
        option.textContent = 'Current conversation';
        els.conversationSelect.append(option);
      }
      lastConversationSignature = signature;
    }

    if (active) {
      els.conversationSelect.value = active;
    } else if (activeId) {
      els.conversationSelect.value = activeId;
    }
  }

  // -------------------------------------------------------------------------
  // Usage limits
  // -------------------------------------------------------------------------

  function renderUsage(quota, quotaError) {
    const container = els.usage;
    container.innerHTML = '';

    const groups = quota && Array.isArray(quota.groups) ? quota.groups : [];

    if (!groups.length) {
      els.usageMeta.textContent = '–';
      container.title = quotaError || '';
      const empty = document.createElement('div');
      empty.className = 'usage-empty';
      empty.textContent = 'Usage limits unavailable.';
      container.append(empty);
      return;
    }

    els.usageMeta.textContent = `${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`;
    container.title = quota.description || '';

    for (const group of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'usage-group';
      groupEl.title = group.description || '';

      const head = document.createElement('div');
      head.className = 'usage-group-head';
      const name = document.createElement('span');
      name.className = 'usage-group-name';
      name.textContent = group.name || 'Usage group';
      head.append(name);
      groupEl.append(head);

      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      if (!buckets.length) {
        const empty = document.createElement('div');
        empty.className = 'usage-empty';
        empty.textContent = 'No limits reported.';
        groupEl.append(empty);
      } else {
        for (const bucket of buckets) {
          const bucketEl = document.createElement('div');
          bucketEl.className = 'usage-bucket';
          bucketEl.title = bucket.description || '';

          const row = document.createElement('div');
          row.className = 'usage-row';
          const label = document.createElement('span');
          label.textContent = bucket.windowTitle || 'Usage limit';
          const value = document.createElement('strong');
          value.textContent = `${formatPercent(bucket.remainingPercent)} left`;
          value.style.color = usageColor(bucket.remainingFraction);
          row.append(label, value);

          const bar = document.createElement('div');
          bar.className = 'usage-bar';
          const fill = document.createElement('div');
          fill.className = 'usage-bar-fill';
          fill.style.width = `${clamp(bucket.remainingPercent, 0, 100)}%`;
          fill.style.background = usageColor(bucket.remainingFraction);
          bar.append(fill);

          const reset = document.createElement('div');
          reset.className = 'usage-reset';
          reset.textContent = formatReset(bucket.resetTime);

          bucketEl.append(row, bar, reset);
          groupEl.append(bucketEl);
        }
      }

      container.append(groupEl);
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderContext(payload) {
    const context = payload.context;
    const conversation = payload.conversation || {};
    const percent = Number(context.percent) || 0;
    const color = percent >= 90 ? DANGER_COLOR : percent >= 70 ? WARN_COLOR : OK_COLOR;

    setAccentColor(color);
    setStatus(percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok');
    setBinding(
      conversation.selected === 'recent'
        ? 'This panel is not bound to a conversation; showing the most recently used one.'
        : ''
    );

    if (percent >= 90) {
      els.banner.className = 'banner danger';
      els.banner.textContent =
        `Context is ${formatPercent(percent)} full. Consider starting a new conversation or summarizing history.`;
    } else if (percent >= 70) {
      els.banner.className = 'banner warn';
      els.banner.textContent = `Context is ${formatPercent(percent)} full. Keep an eye on it in long conversations.`;
    } else {
      els.banner.className = 'banner hidden';
      els.banner.textContent = '';
    }

    if (payload.warning) {
      setBinding(payload.warning);
    }

    els.model.textContent = context.model || 'Unknown model';
    els.percent.textContent = formatPercent(percent);
    els.used.textContent = formatInt(context.used);
    els.remaining.textContent = formatInt(context.remaining);
    els.capacity.textContent = `${formatInt(context.used)} / ${formatInt(context.max)}`;
    els.capacityNote.textContent = `${formatPercent(percent)} used`;

    const clampedPercent = clamp(percent, 0, 100);
    els.gaugeFill.style.strokeDashoffset = String(100 - clampedPercent);
    els.barFill.style.width = `${clampedPercent}%`;
    els.progress.setAttribute('aria-valuenow', String(Math.round(clampedPercent)));

    els.usageInput.textContent = formatInt(context.usage ? context.usage.input : 0);
    els.usageOutput.textContent = formatInt(context.usage ? context.usage.output : 0);
    els.usageThinking.textContent = formatInt(context.usage ? context.usage.thinking : 0);
    els.step.textContent = Number(context.step) >= 0 ? formatInt(context.step) : '–';
    els.generationCount.textContent = `${formatInt(context.generationCount)} generations`;

    els.conversationTitle.textContent = conversation.title || 'Conversation';
    els.updated.textContent = `Last updated ${formatTime(payload.fetchedAt)}`;

    const history = Array.isArray(context.history) ? context.history : [];
    const peak = history.reduce((max, point) => Math.max(max, Number(point.used) || 0), 0);
    els.historyMeta.textContent = `${formatInt(context.generationCount)} generations · peak ${formatCompact(peak)}`;

    renderSparkline(history, color);
    renderUsage(payload.quota, payload.quotaError);
    hideState();
    document.title = `${formatPercent(percent)} · Context Meter`;
  }

  function renderEmpty(payload) {
    const conversation = payload.conversation || {};
    const reason = payload.reason;

    setAccentColor(IDLE_COLOR);
    setStatus('idle');
    els.model.textContent = 'Waiting for measurement';
    setBinding(
      conversation.selected === 'recent'
        ? 'This panel is not bound to a conversation; showing the most recently used one.'
        : ''
    );
    els.banner.className = 'banner hidden';
    els.banner.textContent = '';

    if (payload.warning) {
      setBinding(payload.warning);
    }

    const message =
      reason === 'no-conversation'
        ? 'No open conversation found. Open a conversation and try again.'
        : reason === 'no-generations'
          ? 'No completed model response in this conversation yet. The measurement will appear after the first response.'
          : 'No context measurement found for this conversation.';

    showState({
      icon: '○',
      title: 'No context data yet',
      message,
      retry: true,
    });
  }

  function renderError(message) {
    setAccentColor(DANGER_COLOR);
    setStatus('error');
    els.model.textContent = 'Connection error';
    setBinding('');
    els.banner.className = 'banner hidden';
    els.banner.textContent = '';
    showState({
      icon: '!',
      title: 'Could not load context data',
      message: message || 'Could not reach the Antigravity language server.',
      retry: true,
    });
  }

  function renderSoftError(message) {
    setStatus('warn');
    els.updated.textContent = `Update failed · ${formatTime()}`;
    setBinding(`Last refresh failed: ${message}`);
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.hidden) {
        schedule();
        return;
      }
      refresh({ silent: true });
    }, REFRESH_INTERVAL_MS);
  }

  async function refresh({ force = false, silent = false } = {}) {
    if (inFlight) return;

    inFlight = true;
    const seq = ++requestSeq;

    if (!silent || !currentData) {
      showState({
        spinner: true,
        title: 'Fetching context data…',
        message: 'Requesting the latest measurement from the Antigravity language server.',
        retry: false,
      });
    }
    setSpinning(true);

    try {
      const payload = await api('/api/context', {
        conversationId: currentConversationId || undefined,
        full: force,
      });

      if (seq !== requestSeq) return;

      if (Array.isArray(payload.conversations)) {
        updateConversationOptions(payload.conversations, payload.conversation && payload.conversation.id);
      }

      if (payload.ok && payload.context) {
        currentData = payload;
        renderContext(payload);
      } else if (payload.ok) {
        currentData = null;
        renderEmpty(payload);
      } else {
        const message = payload.error || 'Unknown error';
        if (currentData) renderSoftError(message);
        else renderError(message);
      }
    } catch (error) {
      if (seq !== requestSeq) return;
      const message = error && error.message ? error.message : String(error);
      if (currentData) renderSoftError(message);
      else renderError(message);
    } finally {
      if (seq === requestSeq) {
        inFlight = false;
        setSpinning(false);
        schedule();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  els.refresh.addEventListener('click', () => refresh({ force: true }));
  els.stateRetry.addEventListener('click', () => refresh({ force: true }));

  els.conversationSelect.addEventListener('change', () => {
    currentConversationId = els.conversationSelect.value;
    currentData = null;
    refresh({ force: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh({ silent: true });
  });

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      if (!lastHistory) return;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (lastHistory) renderSparkline(lastHistory, lastHistoryColor);
      });
    });
    observer.observe(els.sparkline);
  }

  setStatus('idle');
  refresh({ force: true });
})();
