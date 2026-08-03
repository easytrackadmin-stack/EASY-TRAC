const SHELL_FLAG_KEY = 'et_shell_v2';
const SHELL_FLAG_VALUE = 'on';

let shellEnabled = localStorage.getItem(SHELL_FLAG_KEY) === SHELL_FLAG_VALUE;
const activationUrl = new URL(window.location.href);

if (activationUrl.searchParams.get('shell') === 'v2') {
  localStorage.setItem(SHELL_FLAG_KEY, SHELL_FLAG_VALUE);
  activationUrl.searchParams.delete('shell');
  history.replaceState(history.state, '', activationUrl.href);
  shellEnabled = true;
}

async function init() {
  if (window.__etShellV2 && window.__etShellV2.initialized) return;

  window.__etShellV2 = {
    initialized: true,
    init,
    rollback: "Clear localStorage key 'et_shell_v2', then reload the page. Live rollback is intentionally unsupported."
  };

  const mountPoint = document.getElementById('appShellV2Root');
  const sidebar = document.getElementById('et-sidebar');
  const main = document.querySelector('.app > .main');
  const userBar = document.getElementById('userBar');

  if (!mountPoint || !sidebar || !main || !userBar) {
    window.__etShellV2.error = 'required-dom-anchor-missing';
    console.error('EasyTrac App Shell v2 could not find its required DOM anchors.');
    return;
  }

  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/assets/app-shell-token-bridge.css';
  stylesheet.dataset.etShellV2Styles = 'true';
  document.head.appendChild(stylesheet);

  const designSystemRoot = '../EasyTrac Tracking Command Center/design_handoff_easytrac_design_system';
  const [
    { createAppShell },
    { createSidebar },
    { createPage },
    { createPanel },
    { createSection },
    { createToolbar },
    { createStoreSwitcher },
    { createDestinationRow },
    { createDataTable },
    { createSelect },
    { createEmptyState },
    { createLoadingState },
    { createSparkline }
  ] = await Promise.all([
    import(`${designSystemRoot}/layout/AppShell.js`),
    import(`${designSystemRoot}/components/Sidebar.js`),
    import(`${designSystemRoot}/layout/Page.js`),
    import(`${designSystemRoot}/layout/Panel.js`),
    import(`${designSystemRoot}/layout/Section.js`),
    import(`${designSystemRoot}/layout/Toolbar.js`),
    import(`${designSystemRoot}/components/StoreSwitcher.js`),
    import(`${designSystemRoot}/operational/DestinationRow.js`),
    import(`${designSystemRoot}/components/DataTable.js`),
    import(`${designSystemRoot}/components/Select.js`),
    import(`${designSystemRoot}/operational/EmptyState.js`),
    import(`${designSystemRoot}/operational/LoadingState.js`),
    import(`${designSystemRoot}/charts/Sparkline.js`)
  ]);

  const storeSwitcher = createStoreSwitcher(
    [{ name: 'EasyTrac Store', statusClass: 'positive' }],
    { current: { name: 'EasyTrac Store', statusClass: 'positive' }, onSwitch() {} }
  );
  storeSwitcher.classList.add('et-shell-v2-store-switcher');

  const sidebarChrome = createSidebar([], {});
  sidebarChrome.classList.add('et-shell-v2-sidebar-chrome');
  sidebarChrome.appendChild(storeSwitcher);
  sidebarChrome.appendChild(sidebar);

  const toolbarChrome = createToolbar({
    className: 'et-shell-v2-toolbar-chrome',
    children: userBar
  });
  const workspaceSection = createSection({
    className: 'et-shell-v2-workspace-section',
    children: main
  });
  const workspacePanel = createPanel({
    className: 'et-shell-v2-workspace-panel',
    children: workspaceSection
  });
  const pageChrome = createPage({
    className: 'et-shell-v2-page-chrome',
    children: [toolbarChrome, workspacePanel]
  });
  const appShell = createAppShell({
    dir: document.documentElement.dir || 'rtl',
    className: 'et-shell-v2-appshell',
    children: [sidebarChrome, pageChrome]
  });

  mountPoint.classList.add('et-design-system-scope');
  mountPoint.appendChild(appShell);

  const destinationsSection = buildDestinationsSection(createDestinationRow);
  const pixelsAnchor = document.getElementById('overviewPixels');
  if (destinationsSection && pixelsAnchor && pixelsAnchor.parentNode) {
    pixelsAnchor.insertAdjacentElement('afterend', destinationsSection);
  }

  const eventsExplorer = mountEventsExplorer({
    createDataTable, createSelect, createEmptyState, createLoadingState, createSparkline
  });

  Object.assign(window.__etShellV2, {
    mountPoint,
    appShell,
    sidebar,
    main,
    userBar,
    destinationsSection,
    eventsExplorer
  });
}

/**
 * Destinations — real-data-only list built from the existing pixel-config
 * state (window.S, populated by the existing setup wizard / refreshOverview()
 * in tool.html). No invented match rates, delivery rates, health scores, or
 * incidents — only fields the app already knows: configured/not, masked
 * pixel ID (same truncation rule refreshOverview() already uses), selected
 * event count, CMS platform, and overall setup completeness (same formula
 * refreshOverview() already computes). "Reconnect" is intentionally never
 * offered — these are pixel-ID destinations, not OAuth connections, so no
 * real connection state exists to reconnect.
 */
function buildDestinationsSection(createDestinationRow) {
  const S = window.S || { platforms: [], pixelIds: {}, events: [], cms: null };
  if (window.__etShellV2 && window.__etShellV2.destinationsSection) {
    return null; // idempotency guard: never build a second copy
  }

  const PLATFORM_LABELS = {
    meta: 'Meta Pixel', snapchat: 'Snap Pixel', tiktok: 'TikTok Pixel',
    google: 'Google Ads', ga4: 'GA4', twitter: 'X / Twitter'
  };
  const CMS_LABELS = {
    salla: 'سلة', zid: 'زد', woocommerce: 'WooCommerce', shopify: 'Shopify', custom: 'Custom Site'
  };

  const section = document.createElement('div');
  section.className = 'et-shell-v2-destinations';

  const heading = document.createElement('div');
  heading.className = 'et-shell-v2-destinations-heading';
  const platforms = S.platforms || [];
  const configuredCount = platforms.filter(function (p) {
    const raw = (typeof S.pixelIds[p] === 'object' ? S.pixelIds[p].id : S.pixelIds[p]) || '';
    return !!String(raw).trim(); // real value present
  }).length;
  const completeness = platforms.length
    ? Math.round((configuredCount / platforms.length) * 100) + '%'
    : '—';
  heading.textContent = 'Destinations · Setup completeness: ' + completeness;
  section.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'et-shell-v2-destinations-list';

  if (!platforms.length) {
    const empty = document.createElement('div');
    empty.className = 'et-shell-v2-destinations-empty';
    empty.textContent = 'No destinations configured yet.';
    list.appendChild(empty);
  }

  platforms.forEach(function (p) {
    const rawId = (typeof S.pixelIds[p] === 'object' ? S.pixelIds[p].id : S.pixelIds[p]) || '';
    const configured = !!(rawId && String(rawId).trim());
    const maskedId = configured
      ? (rawId.length > 10 ? rawId.substring(0, 10) + '...' : rawId)
      : '—';
    const name = PLATFORM_LABELS[p] || p;
    const cmsLabel = S.cms ? (CMS_LABELS[S.cms] || S.cms) : '—';
    const eventCount = (S.events || []).length;

    const row = createDestinationRow({
      name: name,
      state: configured ? 'Connected' : 'Needs Action',
      metric: eventCount + ' event' + (eventCount === 1 ? '' : 's') + ' selected',
      actionLabel: configured ? 'Edit' : 'Configure',
      onAction: function () {
        if (typeof window.switchAppView === 'function') {
          window.switchAppView('pixels', document.getElementById('sbPixels'));
        }
      }
    });

    const detail = document.createElement('div');
    detail.className = 'et-shell-v2-destination-detail';
    detail.textContent = 'ID: ' + maskedId + ' · Store: ' + cmsLabel;

    const card = document.createElement('div');
    card.className = 'et-shell-v2-destination-card';
    card.append(row, detail);
    list.appendChild(card);
  });

  section.appendChild(list);
  return section;
}

/**
 * Events Explorer V1 — real container-ingestion telemetry only.
 *
 * Data source: GET /api/v1/clients/:id/events/summary (owner-scoped,
 * firestore-service.js queryEventSummary() over event_agg_daily +
 * event_agg_shards, committed 4b1a427). This measures events ACCEPTED BY
 * THE EASYTRAC SERVER CONTAINER — it does not confirm GA4 accepted or
 * delivered the event, and the backend has no failure-sample producer
 * (see docs/product/event-observability-v1-implementation-plan.md).
 * Accordingly this view never renders delivery/rejection/match-rate/
 * response-code language — only "Received by EasyTrac" / "Container
 * ingestions" / "Last observed" terminology, and intentionally never reads
 * the `failed`/`validationFailed` counters (always 0 today; showing them
 * would imply a destination-side outcome this data cannot support).
 *
 * Scope: GA4 + purchase only, matching the backend's own rollout allowlist.
 */
const EVENTS_EXPLORER_RANGE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' }
];
const EVENTS_EXPLORER_DEFAULT_RANGE = '14';

function mountEventsExplorer({ createDataTable, createSelect, createEmptyState, createLoadingState, createSparkline }) {
  if (window.__etShellV2 && window.__etShellV2.eventsExplorer) {
    return null; // idempotency guard: never build a second copy
  }

  const opsSection = document.querySelector('#et-sidebar .sb-nav-section');
  const nav = document.querySelector('#et-sidebar .sb-nav');
  if (!nav) return null;

  const view = document.createElement('div');
  view.className = 'app-view';
  view.id = 'view-events';
  const main = document.querySelector('.app > .main') || document.querySelector('.main');
  if (main) main.appendChild(view);

  window.APP_VIEWS = window.APP_VIEWS || {};
  window.APP_VIEWS.events = 'view-events';

  const btn = document.createElement('button');
  btn.className = 'sb-link';
  btn.id = 'sbEvents';
  btn.type = 'button';
  btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">query_stats</span><span>Events</span>';
  btn.addEventListener('click', function () {
    if (typeof window.switchAppView === 'function') window.switchAppView('events', btn);
    renderEventsExplorer(currentRange);
  });
  if (opsSection) opsSection.insertAdjacentElement('beforebegin', btn);
  else nav.appendChild(btn);

  let currentRange = EVENTS_EXPLORER_DEFAULT_RANGE;

  async function fetchSummary(rangeDays) {
    const cid = typeof window._opsClientId === 'function' ? window._opsClientId() : null;
    if (!cid) return { kind: 'error', message: 'Not signed in.' };

    let token;
    try {
      // firebase.auth() itself throws synchronously if the Firebase app was
      // never initialized (e.g. no client config reached the page) — must be
      // inside this try, not just the getIdToken() call, or that throw
      // becomes an unhandled rejection and the view hangs on Loading forever.
      const user = window.firebase && window.firebase.auth().currentUser;
      if (!user) return { kind: 'error', message: 'Not signed in.' };
      token = await user.getIdToken();
    } catch (e) { return { kind: 'error', message: 'Could not verify your session.' }; }

    let res;
    try {
      res = await fetch('/api/v1/clients/' + encodeURIComponent(cid) + '/events/summary?eventName=purchase&destination=ga4&range=' + encodeURIComponent(rangeDays), {
        headers: { Authorization: 'Bearer ' + token }
      });
    } catch (e) {
      return { kind: 'error', message: 'Could not reach the telemetry service.' };
    }

    if (res.status === 503) return { kind: 'disabled' };
    if (!res.ok) return { kind: 'error', message: 'HTTP ' + res.status };

    let data;
    try { data = await res.json(); }
    catch (e) { return { kind: 'error', message: 'Unexpected response from the telemetry service.' }; }

    const rows = Array.isArray(data.rows) ? data.rows : [];
    const live = Array.isArray(data.live) ? data.live : [];
    if (!rows.length && !live.length) return { kind: 'empty' };
    return { kind: 'ok', rows, live };
  }

  function toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    const d = new Date(ts);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function renderResult(result) {
    view.innerHTML = '';

    if (result.kind === 'disabled') {
      view.appendChild(createEmptyState('Telemetry disabled'));
      return;
    }
    if (result.kind === 'error') {
      view.appendChild(createEmptyState('Could not load telemetry — try again. (' + result.message + ')'));
      return;
    }
    if (result.kind === 'empty') {
      view.appendChild(createEmptyState('No events observed'));
      return;
    }

    const rows = result.rows;
    const live = result.live;

    // Container-ingestion count: sum of `accepted` across the daily rollups
    // in the selected range only. `live` (last-hour shards) is intentionally
    // NOT added on top — event_agg_daily is incremented in the same atomic
    // write as the shard doc, so today's daily row already reflects live
    // traffic; summing both would double-count.
    const totalAccepted = rows.reduce(function (sum, r) { return sum + (r.accepted || 0); }, 0);

    // Last observed: the most recent signal across either source — `live`
    // shard buckets are finer-grained (5-minute) than the daily rollup's
    // own updatedAt, so it can be more current.
    let lastObservedMs = 0;
    rows.forEach(function (r) { lastObservedMs = Math.max(lastObservedMs, toMillis(r.updatedAt)); });
    live.forEach(function (b) { lastObservedMs = Math.max(lastObservedMs, toMillis(b.bucketStart)); });
    const lastObservedText = lastObservedMs && typeof window._opsTimeAgo === 'function'
      ? window._opsTimeAgo(new Date(lastObservedMs))
      : (lastObservedMs ? new Date(lastObservedMs).toLocaleString() : '—');

    const toolbarRow = document.createElement('div');
    toolbarRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:12px;';
    const select = createSelect(EVENTS_EXPLORER_RANGE_OPTIONS, {
      value: currentRange,
      onChange: function (value) {
        currentRange = value;
        renderEventsExplorer(currentRange);
      }
    });
    toolbarRow.appendChild(select);
    view.appendChild(toolbarRow);

    const table = createDataTable(
      [
        { key: 'eventName', label: 'Event name' },
        { key: 'destination', label: 'Intended destination' },
        { key: 'accepted', label: 'Container ingestions' },
        { key: 'lastObserved', label: 'Last observed' }
      ],
      [{ eventName: 'purchase', destination: 'GA4', accepted: totalAccepted, lastObserved: lastObservedText }],
      { selectable: false }
    );
    view.appendChild(table);

    const dailySorted = rows.slice().sort(function (a, b) { return toMillis(a.dayStart) - toMillis(b.dayStart); });
    if (dailySorted.length >= 2) {
      const trendWrap = document.createElement('div');
      trendWrap.style.cssText = 'margin-top:16px;';
      const caption = document.createElement('div');
      caption.style.cssText = 'font-size:11px;color:var(--text-tertiary);margin-bottom:6px;';
      caption.textContent = 'Container ingestions by day — received by EasyTrac';
      trendWrap.appendChild(caption);
      trendWrap.appendChild(createSparkline(dailySorted.map(function (r) { return r.accepted || 0; }), { color: 'var(--text-secondary)' }));
      view.appendChild(trendWrap);
    }
  }

  async function renderEventsExplorer(rangeDays) {
    view.innerHTML = '';
    view.appendChild(createLoadingState('Loading telemetry…'));
    const result = await fetchSummary(rangeDays);
    renderResult(result);
  }

  return { view, button: btn, render: renderEventsExplorer };
}

if (shellEnabled) init().catch((error) => {
  window.__etShellV2.error = error;
  console.error('EasyTrac App Shell v2 failed to initialize.', error);
});
