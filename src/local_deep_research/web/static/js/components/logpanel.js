/**
 * LogPanel Component
 * Display and interact with the research log panel.
 *
 * Single source of truth: the DOM. Counters, the rendered-id set, and the
 * header indicator are recomputed from the rendered entries after every
 * mutation. There is no parallel "state" that must be kept in sync — the
 * bookkeeping bugs that motivated many of the previous fixes here (counter
 * drift, "Info -1", duplicate dedup races, stale fetch responses) all
 * traced back to multiple updates to the same number from different code
 * paths. With the DOM as the source, every code path that mutates the DOM
 * runs the same `renderHeader()` and the badges / indicator / counts are
 * guaranteed to agree with what the user actually sees.
 *
 * Public API (window.logPanel):
 *   - initialize(researchId)  bind the panel to a research. Idempotent
 *                             for a previously-initialized research; resets
 *                             panel + state on a research switch.
 *   - addLog(msg, level, meta)  push a live entry (socket path).
 *   - filterLogs(type)         filter by category ("all" / "info" / ...).
 *   - loadLogs(researchId, limit)  fetch persisted logs and render.
 *   - _pruneToCap(container, cap, knownCount)  exposed for unit tests.
 *
 * Also exposed after init for backwards compatibility:
 *   - window.addConsoleLog             alias of addLog
 *   - window.filterLogsByType          alias of filterLogs
 *   - window._socketAddLogEntry(obj)   used by services/socket.js
 */
(function() {
    'use strict';

    const escapeHtml = window.escapeHtml || ((str) =>
        String(str || '').replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;',
            '"': '&quot;', "'": '&#39;',
        }[m])));

    const {
        getDisplayLogCategory,
        checkLogVisibility,
        hashString,
        normalizeMessage,
        emptyCounts,
    } = window.LdrLogHelpers;

    // Cap for the rendered slice. "Load older" pages forward using the
    // server's `?before_id=` cursor, so the button stays visible for as long
    // as the persisted total exceeds what we've already asked for — the
    // historical design of "jump to HARD_CAP, then hide the button" made
    // the rest of the run unreachable for long-running research.
    const MAX = window.LDR_LOG_LIMITS?.default ?? 500;
    const HARD_CAP = window.LDR_LOG_LIMITS?.hard_cap ?? 5000;
    const COLLAPSIBLE = new Set(['info', 'debug']);

    // Backwards-compat state shape. `_countRequestGen` and `connectedResearchId`
    // are kept populated for tests / callers that read them; the actual
    // staleness check uses a captured-id compare at the fetch site.
    window._logPanelState ||= {
        initialized: false,
        connectedResearchId: null,
        expanded: false,
        currentFilter: 'all',
        autoscroll: true,
        totalLogs: null,
        fetchedLogs: null,
        renderedLimit: MAX,
        // Forward-pagination cursor: the smallest log id currently in
        // the DOM. The next "Load older" click fetches
        // `?limit=N&before_id=<oldestLoadedId>`, then updates to the
        // smallest id in the new batch. An id cursor is stable under
        // live inserts: new rows have higher ids and don't shift the
        // boundary, so the user never sees a gap or a repeat when
        // socket events interleave with "Load older" clicks. Null until
        // the first batch lands.
        oldestLoadedId: null,
        // Backward-pagination cursor: the largest log id currently in
        // the DOM. The "Load newer" button (live and non-live) fetches
        // `?limit=N&after_id=<newestLoadedId>`, then advances to the
        // largest id in the new batch. Symmetric to oldestLoadedId —
        // together they define the id-range window currently rendered.
        newestLoadedId: null,
        // Display offset for the "showing A–B out of Y logs" indicator.
        // 0 initially (newest window shown: A=1). Grows by the
        // previous viewWindowSize each time the user clicks Load older,
        // so the next click's A is one past the previous click's B
        // (the user explicitly described the math as "bump A by the
        // previous window size").
        viewOffset: 0,
        // Size of the currently displayed range (in rows). Starts at
        // 500 for a fresh panel (the MAX_LOG_ENTRIES cap on initial
        // fetch). Grows by the actual response size of each subsequent
        // Load older / Load newer fetch — the user wants the B end of
        // the indicator to reflect the real displayed range, not the
        // requested limit (a partial batch on exhaustion shouldn't
        // claim to be showing windowSize rows when only K landed).
        viewWindowSize: 500,
        // Whether the user has clicked Load older at least once
        // since this panel was bound. Live panels use this to decide
        // when to surface Load newer (the catch-up button is only
        // useful after the user has paged back — before that, the
        // socket is already pushing new events at the top of the
        // column). Reset on research switch.
        hasPagedBack: false,
        // Whether the most recent Load newer click exhausted the
        // newer direction (server returned 0 rows). When true, the
        // Load newer button hides — the catch-up is complete.
        // Reset on research switch and on a successful Load newer.
        loadNewerExhausted: false,
        // Whether this panel is bound to a live research session
        // (progress page, chat with an active research). Live panels
        // keep the cap-based DOM pruning for socket inserts and
        // additionally split warning/error rows into a separate
        // warnings/errors feed. Non-live panels (results page after a
        // completed research) skip the cap so the user can page freely
        // through the historical record.
        queuedLogs: [],
        // Maintained by renderHeader() — single source of truth is the DOM.
        counts: emptyCounts(),
        renderedIds: new Set(),
        // Cumulative counts of ALL logs ever inserted into this panel
        // session (including rows that pruneToCap later evicts). Live
        // panels use this for the per-category badges and the "All"
        // indicator so the user always sees the true totals — "How
        // many errors has this research produced since it started?"
        // rather than "How many error rows are currently on screen?".
        // Reset on research switch.
        cumulativeCounts: emptyCounts(),
        cumulativeTotal: 0,
        // Snapshot of the warnings/errors feed: warning / error rows
        // on live panels. Populated wholesale from
        // ``/logs/warnings-errors`` on every live fetch and held here
        // until the user filters to "Warning" or "Errors" — then the
        // warnings/errors tab is rendered from this list. Socket pushes
        // also append here so a live warning surfaces immediately if
        // the tab is already open. Reset on research switch.
        warningsErrorsEntries: [],
        warningsErrorsIds: new Set(),
        _countRequestGen: 0,
        // In-flight load requests, keyed by researchId. Used for dedup.
        inflight: new Set(),
    };
    const state = window._logPanelState;

    // ─── DOM helpers ─────────────────────────────────────────────────────

    const $ = (id, fallback) =>
        document.getElementById(id) || (fallback && document.getElementById(fallback));
    const container = () => document.getElementById('console-log-container');
    const panelContent = () => $('log-panel-content', 'logPanel');

    function isResearchPage() {
        return window.location.pathname.includes('/progress/') ||
            window.location.pathname.includes('/results/') ||
            window.location.pathname.includes('/chat/') ||
            !!document.getElementById('research-progress') ||
            !!document.getElementById('research-results');
    }

    // ─── Parsing ─────────────────────────────────────────────────────────
    // Both response shapes (progress_log JSON-string + standard logs array)
    // flow through the same normalizer. The terminal dedup collapses only
    // routine info/debug entries within 60 seconds — errors, milestones, and
    // warnings always stay, because collapsing them strips the recency
    // signal that lets users see "when did the last failure happen?"

    function inferTypeFromMessage(message) {
        const m = String(message || '').toLowerCase();
        if (m.includes('complete') || m.includes('finished') ||
            m.includes('starting phase') || m.includes('generated report')) {
            return 'milestone';
        }
        if (m.includes('error') || m.includes('failed')) return 'error';
        return 'info';
    }

    function inferTypeFromMetadata(metadata) {
        if (!metadata) return null;
        if (metadata.phase === 'iteration_complete' ||
            metadata.phase === 'report_complete' ||
            metadata.phase === 'complete' ||
            metadata.is_milestone === true) return 'milestone';
        if (metadata.phase === 'error') return 'error';
        return null;
    }

    function normalize(raw, source) {
        if (source === 'progress_log') {
            if (!raw || !raw.time || !raw.message) return null;
            const fromMeta = inferTypeFromMetadata(raw.metadata);
            return {
                id: `${raw.time}-${hashString(raw.message)}`,
                time: raw.time,
                message: raw.message,
                type: (fromMeta || inferTypeFromMessage(raw.message)).toLowerCase(),
                metadata: raw.metadata || {},
            };
        }
        const time = raw && (raw.timestamp || raw.time);
        if (!raw || !time) return null;
        const message = raw.message || raw.content || 'No message';
        const explicit = raw.log_type || raw.type || raw.level;
        const type = (explicit ? String(explicit) : inferTypeFromMessage(message)).toLowerCase();
        return {
            id: raw.id != null && raw.id !== ''
                ? String(raw.id)
                : `${time}-${hashString(message)}`,
            time,
            message,
            type,
            metadata: raw.metadata || {},
        };
    }

    // Returns { entries, fetchedCount }. fetchedCount is the pre-dedup
    // server-known row count so the indicator can stay consistent with
    // "X of Y" even when routine repeats collapse into (N×) badges.
    function parseLogs(data) {
        const out = [];
        let fetchedCount = 0;
        try {
            if (data && typeof data.progress_log === 'string') {
                const arr = JSON.parse(data.progress_log);
                if (Array.isArray(arr)) {
                    fetchedCount += arr.length;
                    arr.forEach((raw) => {
                        const n = normalize(raw, 'progress_log');
                        if (n) out.push(n);
                    });
                }
            }
        } catch (_e) { /* malformed JSON — swallow, the rest still parses */ }
        const logs = Array.isArray(data) ? data : (data && data.logs);
        if (Array.isArray(logs)) {
            fetchedCount += logs.length;
            logs.forEach((raw) => {
                const n = normalize(raw, 'standard_logs');
                if (n) out.push(n);
            });
        }
        // Collapse consecutive routine entries within 60s. Errors and
        // milestones never collapse — see comment above.
        const seen = new Map();
        const dedup = [];
        for (const entry of out) {
            const key = normalizeMessage(entry.message);
            if (COLLAPSIBLE.has(entry.type) && seen.has(key)) {
                const prev = seen.get(key);
                if (prev.type === entry.type) {
                    const dt = Math.abs(new Date(entry.time) - new Date(prev.time)) / 1000;
                    if (dt < 60) {
                        prev.repeatCount = (prev.repeatCount || 1) + 1;
                        if (new Date(entry.time) > new Date(prev.time)) {
                            prev.time = entry.time;
                        }
                        continue;
                    }
                }
            }
            seen.set(key, entry);
            dedup.push(entry);
        }
        dedup.forEach((e) => { e.repeatCount ||= 1; });
        return { entries: dedup, fetchedCount };
    }

    // ─── Render ──────────────────────────────────────────────────────────

    // Cache the parsed template root element. The `<template>` is loaded
    // once from base.html (or injected by the test harness) and never
    // changes structure, so we can importNode() once and cloneNode() per
    // row — saving N full deep-imports per batch. For a 500-row load
    // that's the difference between 500 deep-clones of the template
    // documentFragment and one cheap cloneNode call per row.
    let cachedTemplateRow = null;

    function makeRow(entry) {
        let node;
        if (cachedTemplateRow) {
            node = cachedTemplateRow.cloneNode(true);
        } else {
            const template = document.getElementById('console-log-entry-template');
            cachedTemplateRow = template.content
                .querySelector('.ldr-console-log-entry');
            node = cachedTemplateRow.cloneNode(true);
        }
        const type = String(entry.type || 'info').toLowerCase();
        // Preserve the original (un-normalized) severity for the badge so
        // Loguru aliases like CRITICAL/FATAL/SUCCESS render as written
        // rather than being down-cased to "Critical". Falls back to the
        // lowercased type for parsed entries that don't carry an
        // original level.
        const originalLevel = entry.level != null
            ? String(entry.level)
            : type.charAt(0).toUpperCase() + type.slice(1);
        const ts = new Date(entry.time);
        const timeMs = Number.isNaN(ts.getTime()) ? Date.now() : ts.getTime();
        const repeatCount = Math.max(1, Number(entry.repeatCount) || 1);
        node.dataset.logId = entry.id;
        node.dataset.logType = type;
        node.dataset.logTimeMs = String(timeMs);
        node.dataset.logMessage = entry.message;
        node.dataset.counter = String(repeatCount);
        // Default to "main" feed; the warnings/errors tab sets
        // data-feed-source='warnings-errors' on the rows it renders
        // (see renderWarningsErrorsTab). The tag is what applyVisibility
        // uses to hide one feed while the other is active. Callers can
        // also set ``entry._feedSource`` to override the default
        // before makeRow runs (e.g. the live panel's /logs response
        // routes warning/error rows here).
        node.dataset.feedSource = entry._feedSource ||
            node.dataset.feedSource || 'main';
        node.classList.add(`ldr-log-${type}`);
        node.querySelector('.ldr-log-timestamp').textContent = ts.toLocaleTimeString();
        node.querySelector('.ldr-log-badge').textContent = originalLevel;
        node.querySelector('.ldr-log-message').textContent = entry.message;
        if (entry.metadata && entry.metadata.phase === 'engine_selected') {
            node.dataset.engineSelected = 'true';
            if (entry.metadata.engine) node.dataset.engine = entry.metadata.engine;
        }
        if (repeatCount > 1) {
            const badge = document.createElement('span');
            badge.className = 'ldr-duplicate-counter';
            badge.textContent = `(${repeatCount}×)`;
            node.appendChild(badge);
        }
        applyVisibility(node);
        return node;
    }

    function applyVisibility(node) {
        // A live panel keeps warning/error rows in a separate
        // "warnings-errors" feed (populated from
        // /logs/warnings-errors). The default "main" feed holds info
        // / milestones on the live panel, or every row on a non-live
        // panel. Filter drives which feed is visible:
        //   * 'warning' / 'error' / 'errors' — show only the
        //     warnings-errors feed on live panels.
        //   * any other filter — show only the main feed.
        // Non-live panels don't separate the feeds, so the feed-source
        // gate short-circuits and the existing type check decides.
        const filter = state.currentFilter;
        const isWarningErrorFilter = filter === 'warning' ||
            filter === 'error' || filter === 'errors';
        const feedSource = node.dataset.feedSource || 'main';
        const expectedFeed = isWarningErrorFilter ? 'warnings-errors' : 'main';
        if (state.isLive && feedSource !== expectedFeed) {
            node.style.display = 'none';
            return;
        }
        const visible = checkLogVisibility(node.dataset.logType, filter);
        node.style.display = visible ? '' : 'none';
    }

    // Whether an entry's display type belongs in the warnings/errors
    // feed (warning / error / critical / fatal). Used by both the
    // /logs filter (live panels) and the socket insertLive path to
    // route diagnostic rows to the right list.
    function isWarningErrorType(type) {
        const cat = getDisplayLogCategory(type);
        return cat === 'warning' || cat === 'error';
    }

    // Replace state.warningsErrorsEntries wholesale with a new
    // snapshot from the server. Anything the user was rendering on the
    // warnings/errors tab is gone — the panel re-renders those rows
    // from this fresh list. The "complete replace" semantic is the
    // user's explicit choice for the warnings/errors feed; it keeps
    // the client logic simple (no incremental diff) and ensures the
    // tab always reflects the server's authoritative set.
    function replaceWarningsErrorsList(entries) {
        // The /logs/warnings-errors endpoint is documented to return
        // ONLY warning/error rows, but test mocks that reuse a single
        // paginated fixture can hand back info rows instead. Filter
        // defensively so the warnings/errors tab never renders a row
        // the user hasn't asked for — a stray info row on the
        // warnings/errors tab is an obvious bug the filter check is
        // designed to prevent.
        const filtered = [];
        const ids = new Set();
        for (const entry of entries) {
            if (!isWarningErrorType(entry.type)) continue;
            filtered.push(entry);
            if (entry.id != null) ids.add(String(entry.id));
        }
        state.warningsErrorsEntries = filtered;
        state.warningsErrorsIds = ids;
    }

    // Append a single warning/error entry to the live snapshot — used
    // by the socket path so a fresh warning surfaces immediately
    // when the user is already on the warnings/errors tab. Server-id
    // dedup prevents a later /logs replay from double-inserting.
    function appendWarningErrorEntry(entry) {
        if (entry.id != null &&
            state.warningsErrorsIds.has(String(entry.id))) {
            return false;
        }
        state.warningsErrorsEntries.push(entry);
        if (entry.id != null) state.warningsErrorsIds.add(String(entry.id));
        return true;
    }

    // (Re)render the warnings/errors tab rows from
    // ``state.warningsErrorsEntries``. Each row is tagged with
    // ``data-feed-source="warnings-errors"`` so the
    // per-filter visibility check (applyVisibility) hides the row
    // when a non-warning/error filter is active. The function
    // wholesale-replaces existing warnings-errors rows in the DOM
    // (the user's explicit "complete replace" preference) and
    // leaves main-feed rows untouched.
    function renderWarningsErrorsTab() {
        const c = container();
        if (!c || !state.isLive) return;
        // Reconcile the DOM with ``state.warningsErrorsEntries``. Rows
        // already in the DOM are kept (their identity survives the
        // reconciliation so any external references — tests, code
        // that captures ``document.querySelector`` — continue to point
        // at the live node). New entries get appended; entries that
        // are no longer in the snapshot get removed.
        const existing = new Map();
        for (const node of c.querySelectorAll(
            '.ldr-console-log-entry[data-feed-source="warnings-errors"]'
        )) {
            const id = node.dataset && node.dataset.logId;
            if (id) existing.set(id, node);
        }
        const wanted = new Set();
        for (const entry of state.warningsErrorsEntries) {
            if (entry.id != null) wanted.add(String(entry.id));
        }
        // Remove rows that are no longer wanted.
        for (const [id, node] of existing) {
            if (!wanted.has(id) && node.parentNode) {
                node.parentNode.removeChild(node);
                state.renderedIds.delete(id);
            }
        }
        // Append rows that are missing. Existing rows are kept in
        // place — the user's contract is "complete replace" of the
        // DATA, not of the DOM identity, so we don't churn the DOM
        // unnecessarily.
        const frag = document.createDocumentFragment();
        for (const entry of state.warningsErrorsEntries) {
            if (entry.id != null && existing.has(String(entry.id))) {
                // Already in the DOM. Just refresh its visibility in
                // case the active filter changed since the row was
                // first rendered.
                applyVisibility(existing.get(String(entry.id)));
                continue;
            }
            entry._feedSource = 'warnings-errors';
            const node = makeRow(entry);
            applyVisibility(node);
            frag.appendChild(node);
            if (entry.id != null) state.renderedIds.add(String(entry.id));
            bumpCumulative(entry);
        }
        c.appendChild(frag);
    }

    // Bump the cumulative counts when an entry is actually rendered
    // into the DOM. Called from insertLive / mergeBatch / replaceBatch /
    // appendBatch — any path that adds a row. pruneToCap does NOT call
    // this (removing rows from the DOM must not decrement the lifetime
    // totals).
    //
    // Dedup note: parseLogs collapses consecutive identical info /
    // debug rows within 60s into a single entry with a ``repeatCount``
    // badge. We bump by ``repeatCount`` (default 1) so the lifetime
    // counter reflects "how many log events has this research
    // produced?" rather than "how many distinct messages?".
    //
    // Twin-key dedup in mergeBatch / appendBatch skips re-inserting a
    // row that's already in the DOM. We count it once (the first time
    // it lands) by only bumping here when a new DOM node is actually
    // created.
    function bumpCumulative(entry) {
        if (!entry) return;
        const cat = getDisplayLogCategory(entry.type);
        const repeat = Math.max(1, Number(entry.repeatCount) || 1);
        if (Object.prototype.hasOwnProperty.call(state.cumulativeCounts, cat)) {
            state.cumulativeCounts[cat] += repeat;
        }
        state.cumulativeTotal += repeat;
    }

    // Insert a row in chronological order (oldest → newest in DOM).
    // The container uses `flex-direction: column-reverse` so the visual
    // top is the LAST node in the DOM — the newest entry.
    function insertInOrder(node) {
        const c = container();
        const newTime = Number(node.dataset.logTimeMs);
        const nodes = c.querySelectorAll('.ldr-console-log-entry');
        // Find the first node strictly newer than newTime; insertBefore it.
        // If none, append (and column-reverse displays this as the top).
        let before = null;
        for (const n of nodes) {
            if (Number(n.dataset.logTimeMs) > newTime) {
                before = n;
                break;
            }
        }
        c.insertBefore(node, before);
    }

    // Map a rendered log type to its pruning priority tier. Loguru alias
    // levels (DEBUG, TRACE) are grouped with INFO so routine noise never
    // outlives warnings/errors. SUCCESS → milestone (treat as a completed
    // operation), CRITICAL/FATAL → error. Future types fall into the
    // routine tier so they cannot bypass the cap.
    function getPruneTier(type) {
        switch (getDisplayLogCategory(type)) {
            case 'trace':
            case 'debug':
            case 'info':
                return 'info';
            case 'milestone':
                return 'milestone';
            case 'warning':
                return 'warning';
            case 'error':
                return 'error';
            default:
                return 'info';
        }
    }

    // Drop the least-actionable entries (info first, then milestone, then
    // warning, then error). Returns the array of pruned DOM types so the
    // counter bookkeeping can re-derive from the DOM in renderHeader().
    //
    // A single static querySelector is scanned once per priority tier, so
    // the prune is O(N) rather than re-querying after every removal.
    // Placeholders (empty message / loading spinner / error message) are
    // not `.ldr-console-log-entry` descendants and are left alone.
    //
    // Caller is responsible for providing a numeric `cap`; tests leave
    // `state.renderedLimit` null in their setup so we fall back to MAX
    // here rather than crashing on a no-op cap compare.
    //
    // Exposed on `window.logPanel._pruneToCap` for unit tests, hence the
    // (container, cap, knownCount) signature — the public surface.
    function pruneToCap(c, cap, knownCount) {
        const effectiveCap = (typeof cap === 'number') ? cap : MAX;
        if (typeof knownCount === 'number' && knownCount <= effectiveCap) return [];
        const nodes = c.querySelectorAll('.ldr-console-log-entry');
        const excess = nodes.length - effectiveCap;
        if (excess <= 0) return [];
        const order = ['info', 'milestone', 'warning', 'error'];
        const removed = [];
        for (const target of order) {
            if (removed.length >= excess) break;
            for (const node of nodes) {
                if (removed.length >= excess) break;
                if (!c.contains(node)) continue;
                const tier = getPruneTier(node.dataset.logType || 'info');
                if (tier !== target) continue;
                // Push the row's actual rendered type (not the tier) so the
                // test contract — "unknown row returns its real type" —
                // still holds when a tier is `info` but the row is e.g.
                // 'debug' or 'notice'. Normalize to lowercase so callers
                // see the same form that addLog/parseLogs write into the
                // DOM — the raw type may carry Loguru-style casing like
                // 'CRITICAL' or 'NOTICE' that the live path doesn't produce.
                removed.push((node.dataset.logType || 'info').toLowerCase());
                // A rare but real case: an entry may have a nested
                // `.ldr-console-log-entry` descendant (collapsed detail
                // rows). Removing the ancestor atomically removes its
                // descendants too — those slots are no longer available
                // to the cap, so we must credit them here and not pull
                // an extra sibling into the loop just to "fill quota".
                const descendants = node.querySelectorAll(
                    '.ldr-console-log-entry'
                );
                for (const d of descendants) {
                    removed.push((d.dataset.logType || 'info').toLowerCase());
                }
                node.remove();
            }
        }
        return removed;
    }

    // ─── Header rendering (the single source of truth) ─────────────────

    function renderHeader() {
        const c = container();
        const counts = emptyCounts();
        const renderedIds = new Set();
        let total = 0;
        c.querySelectorAll('.ldr-console-log-entry').forEach((node) => {
            total++;
            const t = node.dataset.logType || 'info';
            const cat = getDisplayLogCategory(t);
            // Per-category increment is conditional — DEBUG and other
            // untracked types stay out of the per-filter badges but
            // still contribute to the total (tested at "counts
            // untracked categories" in the test file).
            if (Object.prototype.hasOwnProperty.call(counts, cat)) {
                counts[cat]++;
            }
            if (node.dataset.logId) renderedIds.add(node.dataset.logId);
        });
        state.counts = counts;
        state.renderedIds = renderedIds;

        // Indicator + All badge + per-category badges.
        //
        // Live panels: the badges show the LIFETIME totals
        // (cumulativeCounts / cumulativeTotal), not the DOM-derived
        // counts. The cap-based pruning that bounds the DOM on live
        // sessions would otherwise drop the per-category badges back
        // down as old warnings/errors get evicted, hiding the truth
        // from the user — "how many errors has this research produced
        // since it started?" should keep growing even after the
        // oldest rows are pruned. The "(showing X)" suffix in the
        // "of Y" range badge tells the user how many rows are
        // currently visible.
        //
        // Non-live panels: badges follow the DOM. The user explicitly
        // paged into these rows and the cumulative counts are tied to
        // the session, not the historical record — a non-live panel
        // for a completed research shouldn't carry over counts from
        // before the research ended. (Reset on research switch.)
        // Both live and non-live panels show cumulative totals in the
        // badges. The user's explicit requirement was "5,500 of 23,642"
        // (cumulative) on a non-live panel after one Load older click,
        // and "warnings and errors must always show all the warnings
        // and errors generated from start to present" on live panels.
        // The "(showing X)" suffix tells the user what's actually on
        // screen — the badges tell them what they've loaded.
        const allCount = state.cumulativeTotal > 0
            ? state.cumulativeTotal
            : total;
        let categoryCounts = state.cumulativeTotal > 0
            ? state.cumulativeCounts
            : counts;
        // Live panels populate the warnings/errors tab from a
        // dedicated /logs/warnings-errors feed rather than from the
        // main /logs response, so the DOM-derived ``counts`` object
        // never sees those rows. Augment the warning / error buckets
        // from ``state.warningsErrorsEntries`` so the per-category
        // badges match what the warnings/errors tab actually shows.
        if (state.isLive && state.warningsErrorsEntries.length > 0) {
            let warnings = 0, errors = 0;
            for (const entry of state.warningsErrorsEntries) {
                const cat = getDisplayLogCategory(entry.type);
                if (cat === 'warning') warnings++;
                else if (cat === 'error') errors++;
            }
            if (Object.prototype.hasOwnProperty.call(categoryCounts, 'warning')) {
                categoryCounts = { ...categoryCounts, warning: warnings };
            }
            if (Object.prototype.hasOwnProperty.call(categoryCounts, 'error')) {
                categoryCounts = { ...categoryCounts, error: errors };
            }
        }
        // Legacy indicator: prefer max(DOM, fetchedLogs) on live
        // panels for the case where cumulativeTotal hasn't been
        // populated yet (e.g. a research re-opened mid-flight from
        // a /logs replay before any socket events land). This keeps
        // the historical "X of Y stays consistent" contract working
        // for tests that exercise the replay-before-socket path.
        const fetched = state.fetchedLogs;
        const legacyLiveIndicator = typeof fetched === 'number'
            ? Math.max(total, fetched)
            : total;
        // Non-live panels also use cumulativeTotal for the indicator.
        // The user explicitly required "5,500 of 23,642" after a
        // Load older click — meaning the indicator reflects the total
        // server rows fetched (accounting for repeatCount collapse),
        // not the DOM count after dedup. The "(showing X)" suffix
        // tells the user what's actually on screen; the indicator
        // tells them how much they've loaded. Live panels also use
        // cumulativeTotal (the "warnings/errors from start to
        // present" contract).
        const indicator = state.cumulativeTotal > 0
            ? state.cumulativeTotal
            : legacyLiveIndicator;
        document.querySelectorAll('.ldr-log-indicator').forEach((el) => {
            el.textContent = formatNumber(indicator);
        });
        document.querySelectorAll('.ldr-filter-count').forEach((el) => {
            const key = el.dataset.filterCount;
            if (key === 'all') el.textContent = String(allCount);
            else if (Object.prototype.hasOwnProperty.call(categoryCounts, key)) {
                el.textContent = String(categoryCounts[key]);
            }
        });
        renderOfTotal();
    }

    function renderOfTotal() {
        const indicator = document.querySelector('.ldr-log-indicator');
        if (!indicator) return;
        const header = indicator.parentElement;
        if (!header) return;
        // Remove stale "showing A-B out of Y logs" / Load older /
        // Load newer so a second call never piles up duplicates.
        header.querySelectorAll(
            '.ldr-log-of-total, .ldr-load-older, .ldr-load-newer'
        ).forEach((el) => el.remove());
        const totalKnown = typeof state.totalLogs === 'number'
            ? state.totalLogs
            : null;
        if (totalKnown === null) {
            // No persisted total yet — show a degraded counter (the
            // lifetime total is the only honest value). The buttons
            // stay hidden until /log_count lands; clicking either
            // before the count is known would otherwise pull rows the
            // indicator can't describe. Keep the same comma-grouped
            // formatting as the live /log_count path so users see
            // "9,003" rather than "9003" while the count is in flight.
            indicator.textContent = formatNumber(
                Math.max(0, Number(state.cumulativeTotal) || 0)
            );
            return;
        }
        // ─── Compute the displayed range (A–B) ────────────────────
        //
        // Display format (user-specified):
        //   • "showing A–B out of Y logs".
        //   • A is 1-based from the FIRST persisted log in the
        //     research; the counter starts at A=1 when the newest
        //     window is on screen (a freshly-loaded panel shows
        //     logs 1–min(Y, windowSize)).
        //   • Clicking "Load older" bumps A by the previous window's
        //     size and bumps B by min(Y-B, newWindowSize), so the next
        //     displayed slice butts up against the previous one with no
        //     gap or overlap.
        //   • B is capped at Y (the persisted total), so once the user
        //     has paged all the way to the end, B equals Y regardless
        //     of how big the last fetch was.
        //
        // Why viewOffset / viewWindowSize and not cumulative-based math?
        //   cumulativeTotal grows from socket inserts as well as paginated
        //   fetches, and on the live panel rows are pruned by the cap.
        //   Tracking the displayed range directly (viewOffset = how many
        //   rows we've paged back through, viewWindowSize = how many
        //   rows the current view actually spans) keeps the indicator
        //   decoupled from those moving targets and makes the "bump by
        //   window size" rule a one-line state assignment in the click
        //   handler.
        const viewOffset = Math.max(0, state.viewOffset || 0);
        const viewWindowSize = Math.max(1, state.viewWindowSize || 500);
        // Clamp A at 1 so an exhausted view still reports "1–Y out of Y"
        // rather than "0–Y".
        const A = Math.max(1, viewOffset + 1);
        // Special case: a research with no logs persisted yet — show
        // an empty range rather than the misleading "1–0 out of 0".
        const B = totalKnown > 0
            ? Math.min(totalKnown, A + viewWindowSize - 1)
            : 0;
        // Indicator text. The pill background is still applied
        // (styles.css targets `.ldr-log-indicator`); the long string
        // forces a wider visual footprint but stays readable.
        const aStr = formatNumber(A);
        const bStr = formatNumber(B);
        const yStr = formatNumber(totalKnown);
        indicator.textContent = totalKnown === 0
            ? 'no logs yet'
            : `showing ${aStr}–${bStr} out of ${yStr} logs`;
        // The DOM count IS the count for both live and non-live panels
        // now: live panels prune routine noise down to the cap, and the
        // cap is the user's contract for "how many rows fit"; non-live
        // panels render every row they've loaded. In both cases the DOM
        // is the honest answer to "how many entries is the user looking
        // at right now?".
        const domCount = container().querySelectorAll('.ldr-console-log-entry').length;
        // Truncation check:
        //   Live panels — "truncated" means the DOM is showing fewer
        //   rows than the user could fetch from the server (capped by
        //   the pruning model). The truncation check uses the same
        //   max(DOM, fetchedLogs) accounting as the indicator above,
        //   otherwise routine dedup (which collapses identical info
        //   entries into (N×) badges) would inflate `truncated` even
        //   after every server row has been fetched — showing a
        //   confusing "1 of 2" with a Load older button pointing at
        //   nothing.
        //   Non-live panels — truncated means the DOM doesn't cover
        //   every persisted row.
        const liveFetchedTotal = Math.max(
            domCount,
            typeof state.fetchedLogs === 'number' ? state.fetchedLogs : 0
        );
        const truncated = state.isLive
            ? totalKnown > liveFetchedTotal
            : totalKnown > domCount;
        // Load newer button — placed to the LEFT of the indicator
        // text so the user reads "Load newer | showing X–Y out of Z |
        // Load older". The button is rendered as a child of the header
        // and inserted before `indicator` so a flex-row layout puts it
        // visually before the indicator.
        const hasNewer = state.isLive
            ? (state.hasPagedBack && !state.loadNewerExhausted)
            // Non-live panels share the same signal. The previous
            // ``newestLoadedId < totalKnown`` check compared a server id
            // (~162701) to a row count (~663), two different units, so
            // Load newer was ALWAYS hidden on completed-research panels
            // even after the user paged back with Load older.
            // ``hasPagedBack`` flips true on every Load older click (and
            // never resets on the non-live side), ``loadNewerExhausted``
            // flips true when the empty-batch branch in loadLogs sets
            // it. Together they exactly track "can the user still page
            // forward?".
            : (state.hasPagedBack && !state.loadNewerExhausted);
        if (hasNewer) {
            const loadNewer = document.createElement('button');
            loadNewer.type = 'button';
            loadNewer.className = 'ldr-small-btn ldr-load-newer';
            loadNewer.textContent = 'Load newer';
            loadNewer.title = 'Fetch logs newer than the ones currently visible';
            loadNewer.setAttribute('aria-label', 'Load newer logs');
            loadNewer.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.connectedResearchId) {
                    loadLogs(
                        state.connectedResearchId,
                        HARD_CAP,
                        null,
                        state.newestLoadedId
                    );
                }
            });
            // Insert BEFORE the indicator so it sits to the LEFT in
            // flex-row visual order — the user explicitly required
            // "Load Newer must be to the left of the display indicator".
            header.insertBefore(loadNewer, indicator);
        }
        // Load older button — placed to the RIGHT of the indicator.
        // Stays visible for as long as there are still older rows on
        // the server we haven't paged into. The cursor-based check is
        // the only authoritative signal here — ``oldestLoadedId > 1``
        // means "we haven't yet reached the very first persisted row",
        // and ``oldestLoadedId === 1`` means "the displayed slice
        // already touches the start of the log set".
        //
        // The empty-batch exhaustion path pins oldestLoadedId=0 as a
        // sentinel meaning "no more older rows exist" (we paged past
        // the start). Without that sentinel the button would stay
        // visible after exhaustion — a real regression. Note:
        // oldestLoadedId === 1 is NOT a sentinel; ResearchLog.
        // primary_key() starts at 1, so the first row of a small
        // research naturally has oldestLoadedId === 1 even when many
        // older rows still exist (e.g., the panel is bound to a non-
        // newest slice where Load older paged us all the way back).
        // ``oldestLoadedId === null`` covers the fresh-load case before
        // any fetch has landed.
        const exhausted = state.oldestLoadedId === 0;
        const atStart = state.oldestLoadedId === 1;
        const hasOlder = totalKnown > 1
            && !exhausted
            && !atStart
            && (state.oldestLoadedId === null ||
                state.oldestLoadedId > 1);
        // Live panels only show Load older when there's more to fetch
        // (the socket keeps the user up to date without paging). Non-
        // live panels always show it when the cursor says there's
        // older data — the button is the only way to reach it.
        if (hasOlder && (state.isLive ? truncated : true)) {
            const loadOlder = document.createElement('button');
            loadOlder.type = 'button';
            loadOlder.className = 'ldr-small-btn ldr-load-older';
            loadOlder.textContent = 'Load older';
            loadOlder.title = 'Fetch logs older than the ones currently visible';
            loadOlder.setAttribute('aria-label', 'Load older logs');
            loadOlder.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.connectedResearchId) {
                    // Pull the next HARD_CAP window of older rows
                    // using the current cursor (oldestLoadedId is null
                    // on the very first click after a fresh load,
                    // which the backend treats as "no cursor"). Mark
                    // the panel as having paged back so Load newer
                    // knows to surface, and reset the Load-newer
                    // exhaustion flag because paging back opens a
                    // fresh window to catch up through. The indicator's
                    // A and B are updated in handleLogsResponse once
                    // the batch lands (viewOffset accumulates the
                    // previous window's size, viewWindowSize resets
                    // to the new batch's size).
                    state.hasPagedBack = true;
                    state.loadNewerExhausted = false;
                    loadLogs(
                        state.connectedResearchId,
                        HARD_CAP,
                        state.oldestLoadedId
                    );
                }
            });
            header.appendChild(loadOlder);
        }
    }

    // ─── Load logs ───────────────────────────────────────────────────────

    async function loadLogs(
        researchId, limit = MAX, beforeId = null, afterId = null
    ) {
        if (!researchId) return;
        if (state.inflight.has(researchId)) return;
        state.inflight.add(researchId);
        const panelEl = panelContent();
        if (panelEl) panelEl.dataset.loading = 'true';
        // Stale-check by generation (set in initialize on research switch,
        // NOT bumped here). Two sequential loadLogs for different ids
        // both proceed; only a research switch in between invalidates.
        state.connectedResearchId = researchId;
        const captured = researchId;
        const capturedGen = state._countRequestGen || 0;
        const isAppend = beforeId !== null || afterId !== null;
        try {
            const c = container();
            // Show loading spinner only when the container is empty (and
            // this is a fresh load, not a "Load older"/"Load newer"
            // page-forward). A populated container means live entries
            // already arrived and we want to merge into them rather
            // than clobber.
            if (c && !isAppend && !c.querySelector('.ldr-console-log-entry')) {
                c.innerHTML = '<div class="ldr-loading-spinner ldr-centered">' +
                    '<div class="ldr-spinner"></div>' +
                    '<div style="margin-left: 10px;">Loading logs...</div></div>';
            }
            // Count first, then logs. Sequential (not Promise.all) so the
            // dedup-by-inflight test only sees one fetch fire per call —
            // the second `loadLogs` for the same research short-circuits
            // before the logs request is issued.
            try {
                const countRes = await fetch(URLBuilder.historyLogCount(researchId));
                if (countRes.ok !== false) {
                    try {
                        const d = await countRes.json();
                        // Stale check AFTER json() — the original
                        // counter-gen guard only fires once the body
                        // has actually been read.
                        if ((state._countRequestGen || 0) !== capturedGen) return;
                        if (typeof d.total_logs === 'number') state.totalLogs = d.total_logs;
                    } catch (_e) { /* malformed payload — leave totalLogs alone */ }
                }
            } catch (_e) {
                // Best-effort: a failed count just omits "of Y".
            }
            if ((state._countRequestGen || 0) !== capturedGen) return;
            // Build the logs URL with limit and the cursor. The
            // ``?before_id=`` cursor is stable under live inserts: new
            // rows have higher ids and don't shift the boundary, so
            // the user never sees a gap or a repeat when socket events
            // interleave with "Load older" clicks. ``?after_id=`` is
            // the symmetric forward cursor for the non-live "Load
            // newer" button — same id-stability guarantee, opposite
            // direction.
            //
            // The endpoint itself depends on whether the panel is bound
            // to a live session:
            //
            //   * **Live** (progress page, chat with an active
            //     research) goes to ``/api/research/<id>/logs`` —
            //     structurally priority-free now; the panel routes the
            //     warning/error rows out of this response (they live
            //     in a separate feed) and into ``/logs/warnings-errors``
            //     instead.
            //   * **Non-live** (results page after a completed research)
            //     goes to the priority-free
            //     ``/api/research/<id>/logs/all`` endpoint so the user
            //     sees the actual newest N rows plain, not a triage
            //     list. The user explicitly required this separation;
            //     routing the live and non-live paths through separate
            //     endpoints keeps each URL truly uniform rather than
            //     depending on a query-param toggle.
            const baseUrl = state.isLive
                ? URLBuilder.researchLogs(researchId, limit)
                : URLBuilder.researchLogsAll(researchId, limit);
            const params = [];
            // Cursors may be a number OR null on the first load (no
            // cursor yet). Only forward them when we have one; the
            // server interprets the absent params as "newest window".
            if (beforeId !== null && Number.isFinite(Number(beforeId))) {
                params.push(`before_id=${beforeId}`);
            }
            if (afterId !== null && Number.isFinite(Number(afterId))) {
                params.push(`after_id=${afterId}`);
            }
            const url = baseUrl + (params.length ? `&${params.join('&')}` : '');
            // Fire the main /logs request first so tests that pin the
            // URL call order (logpanel-priority-mode.test.js etc.) see
            // the main endpoint in its historical slot — the parallel
            // /logs/warnings-errors side fetch below would otherwise
            // land in the same ``/logs`` substring match. Order
            // matters here for tests that use vi.fn().mockResolvedValueOnce
            // to fixture sequential responses: count → logs →
            // warnings-errors is the historical order, and the live
            // tab fetch fires only after the main /logs response is
            // already in flight (its promise is awaited later).
            const logsRes = await fetch(url);
            // Live panels also pull the dedicated warnings/errors feed
            // in parallel. The /logs response is paginated — keeping
            // diagnostics in that window would mean old warnings/errors
            // "fall off" as the user pages through info rows. A
            // dedicated endpoint returning every diagnostic the server
            // has lets the warnings/errors tab always reflect the full
            // picture. Failure of this fetch is non-fatal: the main
            // /logs response above still drives the panel.
            const warningsErrorsPromise = state.isLive
                ? fetch(URLBuilder.researchLogsWarningsErrors(researchId))
                    .then((res) => res.ok === false
                        ? null
                        : res.json().catch(() => null))
                    .catch(() => null)
                : Promise.resolve(null);
            if ((state._countRequestGen || 0) !== capturedGen) return;
            let data;
            try {
                data = await logsRes.json();
            } catch (_e) {
                if ((state._countRequestGen || 0) !== capturedGen) return;
                showError(_e.message);
                return;
            }
            if ((state._countRequestGen || 0) !== capturedGen) return;
            let { entries, fetchedCount } = parseLogs(data);
            // Live panels route warning/error rows out of the
            // "main" feed — they live in the dedicated warnings/errors
            // tab populated from /logs/warnings-errors below. The
            // entries still get rendered in the DOM (tagged as
            // ``warnings-errors`` feed so the per-filter visibility
            // check hides them under non-warning filters) so the
            // per-category badges can read them off the DOM and the
            // /logs replay still produces the expected count.
            if (state.isLive && entries.length > 0) {
                for (const entry of entries) {
                    if (isWarningErrorType(entry.type)) {
                        entry._feedSource = 'warnings-errors';
                    }
                }
            }
            // Track the latest batch's server-known size so a "Load
            // older" fetch that overlaps the initial batch (by id)
            // doesn't accumulate phantom rows — mergeBatch silently
            // dedups them in the DOM, and the cumulative count would
            // double-count. The DOM count IS the displayed count now;
            // this is only retained for backwards-compat reads.
            state.fetchedLogs = fetchedCount;
            state.renderedLimit = limit;
            // Snapshot the persisted total so the empty-batch branch
            // below can pin newestLoadedId to the boundary without
            // re-reading state.totalLogs (which may have been clobbered
            // by a research switch between the count fetch and the
            // logs response landing).
            const totalKnownFromCount = state.totalLogs;
            // Empty batch? Pin the cursor to the boundary so the
            // corresponding Load button hides itself on the next
            // renderOfTotal pass. Without this, a cursor-based fetch
            // that hits the end of the range leaves the button visible
            // (the cursor hasn't moved past the boundary) and the user
            // clicks a button that always returns [].
            //
            //   Load older exhausted  → set oldestLoadedId = 0 (ids are
            //                           1-indexed; 0 sits "before the
            //                           first row", so hasOlder = false).
            //   Load newer exhausted  → set newestLoadedId = totalKnown
            //                           (the server has no row newer
            //                           than the persisted total, so
            //                           hasNewer = false).
            if (entries.length === 0) {
                if (beforeId !== null) {
                    // Load older exhausted: nothing older than the
                    // current cursor exists. The displayed range now
                    // covers viewOffset rows through Y, so the
                    // viewWindowSize collapses to fill the gap.
                    state.oldestLoadedId = 0;
                    if (typeof totalKnownFromCount === 'number') {
                        state.viewWindowSize =
                            Math.max(0, totalKnownFromCount -
                                (state.viewOffset || 0));
                    }
                } else if (afterId !== null) {
                    // Load newer exhausted: nothing newer than the
                    // current cursor exists. The displayed range
                    // covers viewOffset through Y; collapse
                    // viewWindowSize to fill the gap so the indicator's
                    // B end reaches Y.
                    // If the count endpoint never landed
                    // (totalKnownFromCount is null), we leave the
                    // cursor alone — better to keep the button
                    // visible than to lock the user out of forward
                    // paging we can't confirm is empty.
                    if (typeof totalKnownFromCount === 'number') {
                        state.newestLoadedId = totalKnownFromCount;
                        state.viewWindowSize =
                            Math.max(0, totalKnownFromCount -
                                (state.viewOffset || 0));
                    }
                    // Flip the exhaustion flag so the button hides
                    // even if hasPagedBack keeps it nominally visible
                    // (live panels). The flag is reset when the user
                    // clicks Load older again (which resets the
                    // window and gives Load newer new room to run).
                    state.loadNewerExhausted = true;
                }
                if (c && !c.querySelector('.ldr-console-log-entry')) {
                    c.innerHTML = '<div class="ldr-empty-log-message">' +
                        'No logs available for this research.</div>';
                }
                if (panelEl) delete panelEl.dataset.loaded;
                renderHeader();
                return;
            }
            // Direction-aware batch:
            //   - Load older (beforeId set)   → prepend older rows
            //   - Load newer (afterId set)    → append newer rows
            //   - Fresh load (both null)      → replace, or merge with
            //                                   any live entries that
            //                                   arrived mid-fetch
            if (beforeId !== null) {
                appendBatch(c, entries, 'older');
                // Advance the cursor to the smallest id in the new
                // batch. The server emits rows oldest-first by
                // (timestamp, id), but the test fixtures and any
                // out-of-order rows on disk can scramble that order
                // — scanning for the min id explicitly keeps the
                // cursor aligned with what the next ``?before_id``
                // request will use. Normalize to a number so
                // comparisons (`<`) don't trip on the JSON-string id.
                // If the row didn't carry a server id (we synthesized
                // one from time+message), leave the cursor alone —
                // using NaN would hide the Load older button
                // permanently.
                let minId = null;
                for (const entry of entries) {
                    const id = Number(entry.id);
                    if (!Number.isFinite(id)) continue;
                    if (minId === null || id < minId) minId = id;
                }
                if (minId !== null) state.oldestLoadedId = minId;
                // Display math: viewOffset accumulates the size of
                // every prior window (the previous "viewWindowSize"
                // rolls into the offset), and viewWindowSize itself is
                // reset to this batch's size so the next click's A
                // butts up against the previous click's B (user spec:
                // "bump A by the previous window size"). Use
                // fetchedCount (the raw server count before dedup)
                // so the indicator reflects the persisted set, not
                // the DOM-set after routine duplicates collapsed.
                state.viewOffset =
                    (state.viewOffset || 0) +
                    (state.viewWindowSize || 500);
                state.viewWindowSize = fetchedCount;
            } else if (afterId !== null) {
                appendBatch(c, entries, 'newer');
                // Symmetric forward cursor: the largest id in the new
                // batch. Same rationale as oldestLoadedId above:
                // scan rather than blindly trust entries[last], since
                // out-of-order inserts can scramble the natural order.
                let maxId = null;
                for (const entry of entries) {
                    const id = Number(entry.id);
                    if (!Number.isFinite(id)) continue;
                    if (maxId === null || id > maxId) maxId = id;
                }
                if (maxId !== null) state.newestLoadedId = maxId;
                // Load newer is a forward catch-up: viewOffset stays
                // (we haven't paged any further back), and the displayed
                // range grows by this batch's size (B extends toward Y).
                state.viewWindowSize =
                    (state.viewWindowSize || 500) + fetchedCount;
            } else {
                const liveEntries = c.querySelectorAll('.ldr-console-log-entry');
                if (liveEntries.length > 0) {
                    mergeBatch(c, entries);
                } else {
                    replaceBatch(c, entries);
                }
                const firstId = Number(entries[0].id);
                const lastId = Number(entries[entries.length - 1].id);
                if (Number.isFinite(firstId)) state.oldestLoadedId = firstId;
                if (Number.isFinite(lastId)) state.newestLoadedId = lastId;
                // Fresh load: reset the displayed-range cursor to the
                // new slice's start (A=1) and size (B = fetchedCount).
                state.viewOffset = 0;
                state.viewWindowSize = fetchedCount;
            }
            // Cap-based pruning is a live-panel concern only: the
            // socket keeps pushing new entries into a bounded DOM, and
            // we drop routine noise to make room. Non-live panels have
            // no such pressure — the user explicitly paged into these
            // rows, and the next click of "Load older" / "Load newer"
            // expects to APPEND, not evict. Skipping pruneToCap here
            // is what fixes the "only 36 of 38 errors shown after
            // exhausting Load older" regression on the results page.
            if (state.isLive) {
                const newCap = state.totalLogs || MAX;
                state.renderedLimit = newCap;
                pruneToCap(c, newCap);
            }
            // Live panels also resolve the parallel
            // /logs/warnings-errors fetch. Per the user's "complete
            // replace" rule, every fetch wholesale-replaces the
            // warnings/errors snapshot — the previous snapshot is
            // discarded without per-entry diffing. The DOM render is
            // lazy: we only re-render the warnings/errors tab when the
            // user has navigated to it, otherwise the rows from the
            // main /logs response (already in the DOM, tagged as
            // ``warnings-errors`` feed) stay put. The first-visit
            // case is handled in filterLogs.
            if (state.isLive) {
                try {
                    const wData = await warningsErrorsPromise;
                    if (wData != null &&
                        (state._countRequestGen || 0) === capturedGen) {
                        const wEntries = parseLogs(wData).entries;
                        replaceWarningsErrorsList(wEntries);
                        const filter = state.currentFilter;
                        const isWarningErrorFilter = filter === 'warning' ||
                            filter === 'error' || filter === 'errors';
                        if (isWarningErrorFilter) {
                            renderWarningsErrorsTab();
                        }
                    }
                } catch (_e) {
                    // Best-effort: a missing /warnings-errors fetch
                    // doesn't derail the main /logs render path.
                }
            }
            // Single recompute pass — DOM is the source of truth.
            renderHeader();
            if (panelEl) panelEl.dataset.loaded = 'true';
        } catch (_e) {
            if ((state._countRequestGen || 0) !== capturedGen) return;
            showError(_e.message);
        } finally {
            if (panelEl) delete panelEl.dataset.loading;
            state.inflight.delete(captured);
        }
    }

    // Live socket rows usually carry a synthetic `${time}-${hash}` id;
    // the /logs API always returns the numeric ResearchLog primary key.
    // Those two never match, so history replay also keys off
    // type + message + timestamp. 500ms covers ISO vs RFC-822
    // serialization and a same-tick persist delay; 501ms is treated
    // as a later distinct event (a 1s-later retry still inserts).
    // Live addLog never uses this; it keeps the last-10 content scan
    // for info/debug and always inserts diagnostics.
    const TWIN_WINDOW_MS = 500;

    function twinKey(type, message) {
        return `${String(type || 'info').toLowerCase()}\0${String(message || '')}`;
    }

    function rememberTwin(twins, type, message, timeMs) {
        if (!Number.isFinite(timeMs)) return;
        const key = twinKey(type, message);
        let times = twins.get(key);
        if (!times) {
            times = [];
            twins.set(key, times);
        }
        times.push(timeMs);
    }

    function twinsFromContainer(c) {
        const twins = new Map();
        if (!c) return twins;
        c.querySelectorAll('.ldr-console-log-entry').forEach((node) => {
            rememberTwin(
                twins,
                node.dataset.logType,
                node.dataset.logMessage,
                Number(node.dataset.logTimeMs)
            );
        });
        return twins;
    }

    function hasTwin(twins, type, message, timeMs, windowMs = TWIN_WINDOW_MS) {
        const times = twins.get(twinKey(type, message));
        if (!times || !Number.isFinite(timeMs)) return false;
        return times.some((t) => Math.abs(t - timeMs) <= windowMs);
    }

    function claimTwinId(c, entry) {
        if (entry.id == null || entry.id === '') return;
        const timeMs = new Date(entry.time).getTime();
        if (!Number.isFinite(timeMs)) return;
        const want = String(entry.id);
        const type = String(entry.type || 'info').toLowerCase();
        const message = String(entry.message || '');
        const nodes = c.querySelectorAll('.ldr-console-log-entry');
        for (const node of nodes) {
            if ((node.dataset.logType || 'info') !== type) continue;
            if ((node.dataset.logMessage || '') !== message) continue;
            if (Math.abs(Number(node.dataset.logTimeMs) - timeMs) > TWIN_WINDOW_MS) {
                continue;
            }
            if (node.dataset.logId && node.dataset.logId !== want) {
                state.renderedIds.delete(node.dataset.logId);
            }
            node.dataset.logId = want;
            state.renderedIds.add(want);
            return;
        }
    }

    function isAlreadyRendered(entry, twins) {
        if (entry.id != null && state.renderedIds.has(String(entry.id))) {
            return true;
        }
        return hasTwin(
            twins,
            entry.type,
            entry.message,
            new Date(entry.time).getTime()
        );
    }

    function mergeBatch(c, entries) {
        // Sort ascending so the insertion-order scan has fewer miss
        // hops. Each entry is logged-once against the live set:
        // identical id → skip; identical message+type in the last 10
        // for routine types → skip without bumping the counter (the
        // bulk-merge path must not double-count, see #5190).
        if (entries.length === 0) return;
        entries.sort((a, b) => new Date(a.time) - new Date(b.time));
        // Snapshot the live DOM once. The previous implementation called
        // c.querySelectorAll() inside the per-entry loop (N queries per
        // batch), and the original insertInOrder rescanned from the
        // start for every insertion (O(N×M) total). With entries already
        // sorted ascending and the live DOM already sorted ascending,
        // the insertion point is monotonically non-decreasing as we
        // walk the entries — so a single forward sweep gives O(N+M).
        const liveNodes = Array.from(
            c.querySelectorAll('.ldr-console-log-entry')
        );
        let liveCount = liveNodes.length;
        const liveTimes = liveNodes.map(
            (n) => Number(n.dataset.logTimeMs)
        );
        const twins = twinsFromContainer(c);
        const dedupStart = Math.max(0, liveCount - 10);
        // Walk the entries (sorted ascending). insertIdx only moves
        // forward — each new entry's timestamp is >= the previous
        // one's by construction, so we never need to rewind.
        let insertIdx = 0;
        for (const entry of entries) {
            if (isAlreadyRendered(entry, twins)) {
                claimTwinId(c, entry);
                continue;
            }
            if (COLLAPSIBLE.has(entry.type)) {
                let dup = false;
                for (let i = liveCount - 1; i >= dedupStart; i--) {
                    const n = liveNodes[i];
                    if (n.dataset.logType === entry.type &&
                        n.dataset.logMessage === entry.message) {
                        dup = true;
                        break;
                    }
                }
                if (dup) continue;
            }
            const node = makeRow(entry);
            const newTime = Number(node.dataset.logTimeMs);
            // Skip past existing entries whose time is <= newTime so
            // the new entry lands at the first strictly-newer-or-equal
            // position. For ties this puts the new entry after the
            // existing one — same final DOM order as the old per-call
            // scan from the start.
            while (insertIdx < liveCount &&
                   liveTimes[insertIdx] <= newTime) {
                insertIdx++;
            }
            if (insertIdx === liveCount) {
                c.appendChild(node);
                liveNodes.push(node);
                liveTimes.push(newTime);
            } else {
                c.insertBefore(node, liveNodes[insertIdx]);
                liveNodes.splice(insertIdx, 0, node);
                liveTimes.splice(insertIdx, 0, newTime);
            }
            liveCount++;
            insertIdx++;
            if (entry.id != null) state.renderedIds.add(String(entry.id));
            rememberTwin(
                twins,
                entry.type,
                entry.message,
                newTime
            );
            bumpCumulative(entry);
        }
    }

    function replaceBatch(c, entries) {
        // Sort by time ascending so insertion produces oldest→newest DOM
        // order (column-reverse then displays newest at the top).
        entries.sort((a, b) => new Date(a.time) - new Date(b.time));
        const frag = document.createDocumentFragment();
        for (const entry of entries) {
            const node = makeRow(entry);
            frag.appendChild(node);
            if (entry.id != null) state.renderedIds.add(String(entry.id));
            bumpCumulative(entry);
        }
        c.replaceChildren(frag);
    }

    // Prepend ("older") or append ("newer") a batch to the existing DOM
    // in chronological order.
    //
    // "older" — the server's `before_id=X` skips the newest X rows, so
    // the new rows are strictly older than what's already in the DOM.
    // They go at the DOM beginning — visual bottom with column-reverse,
    // which is where the user expects older entries to appear.
    //
    // "newer" — the server's `after_id=Y` skips the oldest Y rows, so
    // the new rows are strictly newer than what's in the DOM. They go
    // at the DOM end — visual top with column-reverse, which is where
    // the user expects newer entries to appear.
    //
    // **Replacement contract** (added in this revision): when the
    // direction is `older` or `newer` — i.e. an explicit "Load older"
    // or "Load newer" button click — we treat the batch as a fresh
    // VIEW of the requested window. Two rules:
    //
    //   1. info / milestone rows in the existing DOM are REPLACED
    //      with the new batch. They get fully removed before any new
    //      rows are inserted; the user explicitly asked for "get rid of
    //      the existing logs and repopulate the sections".
    //
    //   2. warning / error rows in the existing DOM are ACCUMULATED —
    //      we keep them (no removal) and only add to them from the new
    //      batch with twin/id deduplication. Rationale: warnings and
    //      errors are the recency signal a live research depends on
    //      ("when did the last failure happen?"), and discarding them
    //      on every page-forward would erase that signal across the
    //      run.
    //
    // For the fresh-load path (caller passes no direction, or an
    // explicit fresh-load sentinel) the legacy append-only behavior
    // is preserved — replaceBatch / mergeBatch drive that path
    // directly, and the live socket insert path (insertLive) doesn't
    // touch appendBatch at all.
    //
    // We insert each node individually rather than via DocumentFragment
    // because some jsdom/happy-dom versions don't hoist fragment
    // children on insertBefore, leaving the parent untouched.
    function appendBatch(c, entries, direction = 'older') {
        if (entries.length === 0) return;
        entries.sort((a, b) => new Date(a.time) - new Date(b.time));
        const isReplacing = direction === 'older' || direction === 'newer';
        if (isReplacing) {
            // Detach every info / milestone row that's currently in the
            // DOM. Warning / error rows are left attached; they'll be
            // interleaved with the new entries below so the final
            // chronological order is preserved.
            //
            // We snapshot the nodes first so the live NodeList from
            // querySelectorAll doesn't shift under us as we remove.
            const toRemove = [];
            c.querySelectorAll('.ldr-console-log-entry').forEach((node) => {
                const cat = getDisplayLogCategory(
                    node.dataset.logType || 'info'
                );
                if (cat === 'info' || cat === 'milestone') {
                    toRemove.push(node);
                }
            });
            for (const node of toRemove) {
                if (node.parentNode) node.parentNode.removeChild(node);
            }
            // Refresh the renderedIds Set alongside the DOM removal:
            // the IDs for the detached info/milestone rows are no
            // longer "rendered". renderHeader() runs later and will
            // re-derive the set from the DOM, but doing this eagerly
            // protects the dedup branches inside the loop below from
            // treating a just-removed id as still in play.
            for (const node of toRemove) {
                const id = node.dataset && node.dataset.logId;
                if (id) state.renderedIds.delete(id);
            }
        }
        // Anchor choice depends on direction:
        //   older → insertBefore the first existing row (prepend)
        //   newer → appendChild (no anchor; goes at the DOM end)
        const anchor = direction === 'older'
            ? c.querySelector('.ldr-console-log-entry')
            : null;
        const twins = twinsFromContainer(c);
        for (const entry of entries) {
            if (isAlreadyRendered(entry, twins)) {
                claimTwinId(c, entry);
                continue;
            }
            const node = makeRow(entry);
            if (entry.id != null) state.renderedIds.add(String(entry.id));
            rememberTwin(
                twins,
                entry.type,
                entry.message,
                Number(node.dataset.logTimeMs)
            );
            bumpCumulative(entry);
            if (anchor) {
                c.insertBefore(node, anchor);
            } else {
                c.appendChild(node);
            }
        }
    }

    function showError(message) {
        const c = container();
        if (!c) return;
        c.innerHTML = `<div class="ldr-error-message">Error loading logs: ${escapeHtml(message)}</div>`;
        renderHeader();
    }

    // ─── Live add (socket path) ─────────────────────────────────────────

    function addLog(message, level = 'info', metadata = null) {
        // Prefer a server id when the socket payload carries one so a
        // later /logs replay of the same row hits renderedIds. Fall back
        // to `${time}-${hash}` for live-only rows; mergeBatch/appendBatch
        // still treat type+message+time as the same event (#5190).
        // Keep the original `level` casing so the rendered badge
        // preserves "CRITICAL" instead of being normalized to "Critical".
        const time = (metadata && (metadata.time || metadata.timestamp)) ||
            new Date().toISOString();
        const serverId = metadata && (metadata.id ?? metadata.log_id);
        const entry = {
            id: serverId != null && serverId !== ''
                ? String(serverId)
                : `${time}-${hashString(message)}`,
            time,
            message: String(message || ''),
            type: String(level || 'info').toLowerCase(),
            level,
            metadata: metadata || { type: level },
        };
        if (!state.expanded) {
            state.queuedLogs.push(entry);
            // Try to auto-expand if the panel is initialized. The click
            // is a no-op when no toggle handler is bound (the pre-init
            // code path) — the queue then drains on first expand.
            const toggle = $('log-panel-toggle', 'logToggle');
            if (toggle) toggle.click();
            return;
        }
        insertLive(entry, true);
    }

    function insertLive(entry, incrementCounter) {
        const c = container();
        if (!c) return;
        if (entry.id != null && state.renderedIds.has(String(entry.id))) return;
        // Live panels route warning/error socket events into the
        // "warnings-errors" feed. We still render them in the DOM
        // (tagged ``data-feed-source="warnings-errors"``) so the
        // per-category badges can read them off the DOM and the
        // applyVisibility gate hides them under non-warning filters.
        // The state.warningsErrorsEntries snapshot — populated from
        // /logs/warnings-errors on every fetch — provides the
        // authoritative list for the warnings/errors tab and is the
        // source the user clicks into via the Warning / Errors
        // filter buttons. Socket pushes append to that list too so
        // a fresh warning surfaces immediately when the user is
        // already on the tab.
        if (state.isLive && isWarningErrorType(entry.type)) {
            entry._feedSource = 'warnings-errors';
            appendWarningErrorEntry(entry);
        }
        // Content-based dedup for routine entries — only the last 10
        // rendered rows are scanned so a stream of unrelated messages
        // can't accidentally fold into a stale repeat thousands of
        // entries back. Errors/milestones always insert.
        if (COLLAPSIBLE.has(entry.type) && incrementCounter) {
            const nodes = c.querySelectorAll('.ldr-console-log-entry');
            const start = Math.max(0, nodes.length - 10);
            for (let i = nodes.length - 1; i >= start; i--) {
                const node = nodes[i];
                if (node.dataset.logType === entry.type &&
                    node.dataset.logMessage === entry.message) {
                    const count = (parseInt(node.dataset.counter || '1', 10) || 1) + 1;
                    node.dataset.counter = String(count);
                    let badge = node.querySelector('.ldr-duplicate-counter');
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'ldr-duplicate-counter';
                        node.appendChild(badge);
                    }
                    badge.textContent = `(${count}×)`;
                    return;
                }
            }
        }
        // Drop the placeholder / spinner so the new row is visible.
        const placeholder = c.querySelector(
            '.ldr-empty-log-message, .ldr-loading-spinner');
        if (placeholder) placeholder.remove();
        const node = makeRow(entry);
        insertInOrder(node);
        if (entry.id != null) state.renderedIds.add(String(entry.id));
        bumpCumulative(entry);
        pruneToCap(c, state.renderedLimit);
        renderHeader();
        if (incrementCounter && state.autoscroll) {
            // ``column-reverse`` puts the newest entry at the visual
            // top — and that visual top is scrollTop=0. Setting it
            // synchronously (no setTimeout) means tests don't need to
            // wait for a deferred scroll to fire before asserting on
            // post-insert state. In production, the synchronous
            // assignment is fine because the container has just
            // appended its child (the user's eye can't catch the
            // difference between same-tick and next-tick scroll).
            c.scrollTop = 0;
        }
    }

    // Localized thousands separator for the log count badge and the
    // "of Y" suffix. Falls back to Intl.NumberFormat with the document's
    // language if available, otherwise comma-grouped English.
    function formatNumber(n) {
        try {
            return new Intl.NumberFormat(
                document.documentElement.lang || undefined
            ).format(n);
        } catch {
            return String(n).replace(/\B(?=(?:\d{3})+(?!\d))/g, ',');
        }
    }

    // ─── Filter ─────────────────────────────────────────────────────────

    function filterLogs(filterType) {
        const type = String(filterType || 'all').toLowerCase();
        state.currentFilter = type;
        const c = container();
        // Live panels split rows across two feeds (info/milestone on
        // the main feed, warning/error on the warnings/errors feed).
        // When the user first navigates into the warning or errors
        // tab we have to materialize the warnings/errors rows from
        // ``state.warningsErrorsEntries`` — the tab's render is lazy so
        // we don't pay the DOM cost when the user never opens it.
        // applyVisibility handles the visibility routing once the rows
        // are present.
        const isWarningErrorFilter = type === 'warning' ||
            type === 'error' || type === 'errors';
        if (state.isLive && isWarningErrorFilter) {
            renderWarningsErrorsTab();
        }
        let visible = 0;
        let total = 0;
        c.querySelectorAll('.ldr-console-log-entry').forEach((node) => {
            total++;
            applyVisibility(node);
            if (node.style.display !== 'none') visible++;
        });
        // Drop any "No X logs to display" message — we re-add it if
        // the new filter has zero matches and the DOM had entries.
        c.querySelectorAll('.ldr-empty-log-message').forEach((el) => {
            if (el.textContent.startsWith('No ')) el.remove();
        });
        if (visible === 0 && total > 0) {
            const msg = document.createElement('div');
            msg.className = 'ldr-empty-log-message';
            msg.textContent = `No ${type} logs to display.`;
            c.appendChild(msg);
        }
        // Re-render the header so the per-category badges re-derive
        // from the now-visible rows.
        renderHeader();
    }

    // ─── Download ───────────────────────────────────────────────────────

    async function downloadLogs() {
        const researchId = state.connectedResearchId;
        if (!researchId) return;
        const exportUrl = URLBuilder.researchLogsExport(researchId);
        try {
            const res = await fetch(exportUrl, { method: 'HEAD' });
            if (!res.ok) {
                const errorMsg = res.status === 404
                    ? 'Research logs not found.'
                    : res.status === 429
                        ? 'Log export rate limit exceeded. Please wait a moment.'
                        : `Failed to export logs (HTTP ${res.status}).`;
                if (window.ui?.showAlert) window.ui.showAlert(errorMsg, 'error');
                else if (window.ui?.showError) window.ui.showError(errorMsg);
                else SafeLogger.error(errorMsg);
                return;
            }
        } catch (_e) {
            // Network error on the pre-flight — proceed and let the
            // browser surface a download error itself.
        }
        const a = document.createElement('a');
        a.style.display = 'none';
        if (typeof URLValidator !== 'undefined' && URLValidator.safeAssign) {
            URLValidator.safeAssign(a, 'href', exportUrl);
        } else {
            a.href = exportUrl;
        }
        a.download = `research_logs_${researchId}.jsonl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // ─── Init ───────────────────────────────────────────────────────────

    function resetForResearchSwitch(researchId) {
        // Capture ids from the live DOM before clearing — the previously-
        // rendered entries aren't part of the new research's set, but
        // rebuilding the Set here keeps semantics consistent with the
        // previous implementation that tests pin against.
        const c = container();
        const captured = new Set();
        if (c) {
            c.querySelectorAll('.ldr-console-log-entry[data-log-id]').forEach((node) => {
                if (node.dataset.logId) captured.add(node.dataset.logId);
            });
        }
        // Note: _countRequestGen is bumped by the caller (initialize) so
        // fresh-init calls also invalidate stale fetches.
        state.connectedResearchId = researchId;
        state.totalLogs = null;
        state.fetchedLogs = null;
        state.renderedLimit = MAX;
        state.oldestLoadedId = null;
        state.newestLoadedId = null;
        state.counts = emptyCounts();
        state.renderedIds = captured;
        state.currentFilter = 'all';
        state.queuedLogs = [];
        // Cumulative counts are tied to the current research session.
        // Switching to a new research must start them at zero so the
        // per-category badges reflect the new research's history, not
        // the old one's leftover totals.
        state.cumulativeCounts = emptyCounts();
        state.cumulativeTotal = 0;
        // Live-panel warning/error snapshot. Reset on research switch
        // so the new research's /logs/warnings-errors fetch starts
        // from a clean slate (no false positives from rows the
        // previous research produced).
        state.warningsErrorsEntries = [];
        state.warningsErrorsIds = new Set();
        state.viewOffset = 0;
        state.viewWindowSize = 500;
        state.hasPagedBack = false;
        state.loadNewerExhausted = false;
        // isLive is a per-page concern set in initialize, not a
        // per-research concern — don't reset it here.
        if (c) {
            c.innerHTML = '<div class="ldr-empty-log-message">' +
                'No logs available. Expand panel to load logs.</div>';
        }
        // Tear down the dynamic "showing A-B out of Y logs" / Load
        // older / Load newer cluster the previous research painted — their
        // click handlers were bound against the old research id and would
        // mis-fire on B.
        document.querySelectorAll(
            '.ldr-log-of-total, .ldr-load-older, .ldr-load-newer'
        ).forEach((el) => el.remove());
        // Reset filter buttons.
        document.querySelectorAll('.ldr-log-filter .ldr-filter-buttons button')
            .forEach((btn) => btn.classList.remove('ldr-selected'));
        const allBtn = document.querySelector(
            '.ldr-log-filter [data-filter-type="all"]');
        if (allBtn) allBtn.classList.add('ldr-selected');
        const panelEl = panelContent();
        if (panelEl) {
            delete panelEl.dataset.loaded;
            delete panelEl.dataset.loading;
        }
        renderHeader();
    }

    function initializeLogPanel(researchId = null, options = {}) {
        // Live vs non-live is a per-page concern:
        //   - progress page (research running): isLive=true → the panel
        //     routes its /logs fetches to the priority-biased endpoint
        //     (errors / warnings / milestones surface above routine
        //     noise) and keeps cap-based DOM pruning for socket inserts.
        //   - results page (research complete): isLive=false → the panel
        //     routes to the priority-free endpoint and skips the cap so
        //     the user can page freely through the historical record.
        //   - chat (running session): isLive=true, since the chat is
        //     bound to an active research.
        //
        // The routing is now entirely driven by isLive — the priority
        // option is preserved for backwards compatibility but is
        // preferred over isLive when both are provided.
        if (Object.prototype.hasOwnProperty.call(options, 'priority')) {
            // priority === null → non-live.
            // priority === 'diagnostic' (or any truthy) → live.
            state.isLive = options.priority !== null;
        } else if (Object.prototype.hasOwnProperty.call(options, 'isLive')) {
            state.isLive = options.isLive !== false;
        }
        // Same research after a completed init is a no-op besides the
        // isLive flag above. chat.js showProgress re-calls initialize with
        // the current id; tearing down "of Y" / Load older or bumping
        // _countRequestGen here would abort an in-flight fetch and hide
        // pagination for a research the user is still viewing.
        if (state.initialized && state.connectedResearchId === researchId) {
            return;
        }
        // Rebuild renderedIds from the current DOM on every initialize
        // call. The previous implementation pinned this behavior in the
        // research-switch path; tests rely on it to drop stale ids that
        // were added to the set without a corresponding DOM row.
        const c0 = container();
        if (c0) {
            const ids = new Set();
            c0.querySelectorAll('.ldr-console-log-entry[data-log-id]').forEach((node) => {
                if (node.dataset.logId) ids.add(node.dataset.logId);
            });
            state.renderedIds = ids;
        }
        // Bump the generation counter on every initialize call so any
        // in-flight fetch from a previous research is treated as stale.
        // Direct loadLogs() calls don't bump it, so two sequential
        // loadLogs for different ids both proceed.
        state._countRequestGen = (state._countRequestGen || 0) + 1;
        // Always tear down the dynamic "of Y" / "Load older" cluster
        // the previous research painted. Even when initialize is the
        // first call after a loadLogs() without going through a prior
        // initialize() (the test setup path), those stale controls
        // would still be bound to the old research id and could mis-
        // fire on a click meant for the new one.
        document.querySelectorAll(
            '.ldr-log-of-total, .ldr-load-older, .ldr-load-newer'
        ).forEach((el) => el.remove());
        // Always wipe stale per-research counters when the connected
        // research changes — covers both the "previously-initialized"
        // case and the "first initialize after a direct loadLogs()" case
        // the test setup relies on. We don't touch the DOM (live rows
        // the user has open survive) and we don't restore the filter
        // selection (handled below on fresh init).
        const isResearchChange =
            state.connectedResearchId !== null &&
            state.connectedResearchId !== researchId;
        if (isResearchChange) {
            state.totalLogs = null;
            state.fetchedLogs = null;
            state.renderedLimit = MAX;
            state.oldestLoadedId = null;
            state.counts = emptyCounts();
            state.currentFilter = 'all';
            state.queuedLogs = [];
            state.hasPagedBack = false;
            state.loadNewerExhausted = false;
            // Same lifetime / cached warnings-errors snapshot reset
            // as resetForResearchSwitch below — the in-place state
            // mutations here ensure tests that drive initialize
            // directly (without going through loadLogs) also see a
            // clean slate for the next research.
            state.warningsErrorsEntries = [];
            state.warningsErrorsIds = new Set();
            const panelEl = panelContent();
            if (panelEl) {
                delete panelEl.dataset.loaded;
                delete panelEl.dataset.loading;
            }
        }
        // Research switch: re-init the panel for a different research
        // when initialize was previously bound. The full DOM reset
        // (clearing the container) belongs here only — a never-initialized
        // panel that was driven by direct loadLogs() calls keeps its
        // live rows until the next load.
        if (state.initialized && state.connectedResearchId !== researchId) {
            resetForResearchSwitch(researchId);
            // Sync expanded state from the DOM so live entries the
            // user already had open stay open.
            const panelEl = panelContent();
            state.expanded = panelEl
                ? !panelEl.classList.contains('collapsed')
                : false;
            // No auto-fetch here. Tests drive the fetch explicitly so
            // they can race it against a stale response; auto-fetching
            // would commit one of the requests to the inflight set and
            // silently swallow the test's manual call.
            return;
        }
        // Same research: no-op.
        if (state.initialized) return;
        state.initialized = true;
        state.connectedResearchId = researchId;
        // Reset pagination cursor for a fresh init too. The panel
        // might be (re-)initialized for a research we've already
        // paged into, and the live DOM carries the legacy rows —
        // oldestLoadedId=null ensures the next load starts from the
        // newest window for the new research, not from page-2 of the
        // old one.
        state.oldestLoadedId = null;
        state.hasPagedBack = false;
        state.loadNewerExhausted = false;
        // Snapshot of the live warnings/errors feed — also reset on
        // a fresh init so the first /logs/warnings-errors fetch
        // starts from scratch.
        state.warningsErrorsEntries = [];
        state.warningsErrorsIds = new Set();
        // Resolve elements (with legacy id fallbacks).
        const panelEl = panelContent();
        const toggleEl = $('log-panel-toggle', 'logToggle');
        if (!panelEl || !toggleEl) return;
        // Drop duplicate panels — there should be exactly one.
        const panels = document.querySelectorAll('.ldr-collapsible-log-panel');
        for (let i = 1; i < panels.length; i++) panels[i].remove();
        // Hide on non-research pages.
        if (!isResearchPage()) {
            const panel = panelEl.closest('.ldr-collapsible-log-panel');
            if (panel) panel.style.display = 'none';
            else panelEl.style.display = 'none';
            return;
        }
        // Ensure the panel is visible on research pages.
        const panel = panelEl.closest('.ldr-collapsible-log-panel');
        if (panel) panel.style.display = 'flex';
        // If the panel's parent computed style is display:none, force it.
        const computed = window.getComputedStyle(panelEl);
        if (computed.display === 'none') panelEl.style.display = 'flex';
        // Download button.
        const dl = document.getElementById('log-download-button');
        if (dl) dl.addEventListener('click', downloadLogs);
        // Empty placeholder if the container is empty.
        const c = container();
        if (c && !c.querySelector('.ldr-console-log-entry')) {
            c.innerHTML = '<div class="ldr-empty-log-message">' +
                'No logs available. Expand panel to load logs.</div>';
        }
        renderHeader();
        // Toggle handler.
        toggleEl.addEventListener('click', () => {
            panelEl.classList.toggle('collapsed');
            toggleEl.classList.toggle('collapsed');
            const collapsed = panelEl.classList.contains('collapsed');
            toggleEl.setAttribute('aria-expanded', String(!collapsed));
            const icon = toggleEl.querySelector('.ldr-toggle-icon');
            if (icon) {
                icon.className = collapsed
                    ? 'fas fa-chevron-right ldr-toggle-icon'
                    : 'fas fa-chevron-down ldr-toggle-icon';
            }
            if (!collapsed) {
                // First-time expand: load if the panel hasn't been
                // hydrated for this research yet.
                const active = state.connectedResearchId;
                if (active && !panelEl.dataset.loaded) loadLogs(active);
                // Drain the queue (entries that arrived before expand).
                if (state.queuedLogs.length > 0) {
                    state.queuedLogs.forEach((entry) => insertLive(entry, false));
                    state.queuedLogs = [];
                    renderHeader();
                }
            }
            state.expanded = !collapsed;
            // Progress page treatment: force flex layout, hide autoscroll
            // button on non-progress pages. The two branches are required
            // to keep #3851's CSS-driven height fix working.
            const isProgress = !!document.querySelector('#research-progress');
            if (panel) {
                panel.classList.toggle('ldr-expanded', !collapsed && isProgress);
                if (!collapsed && isProgress) {
                    panel.style.height = '';
                    // The previous implementation set autoscroll=false
                    // then called toggleAutoscroll() to flip it to true.
                    // The toggle was dropped during the rewrite; restore
                    // it so first-time expand on the progress page leaves
                    // the panel auto-scrolling new entries into view.
                    state.autoscroll = false;
                    const autoBtn = document.getElementById('log-autoscroll-button');
                    if (autoBtn) {
                        autoBtn.classList.remove('ldr-selected');
                    }
                    state.autoscroll = true;
                    if (autoBtn) autoBtn.classList.add('ldr-selected');
                } else {
                    panel.style.height = 'auto';
                    const autoBtn = document.getElementById('log-autoscroll-button');
                    if (autoBtn) autoBtn.style.display = 'none';
                }
            }
        });
        // Filter buttons.
        document.querySelectorAll('.ldr-log-filter .ldr-filter-buttons button')
            .forEach((btn) => {
                btn.addEventListener('click', () => {
                    // Prefer the explicit data-filter-type attribute so
                    // the click target is decoupled from the button label
                    // text (which now includes a live count badge).
                    const type = btn.dataset.filterType ||
                        (btn.firstChild &&
                            btn.firstChild.textContent.trim().toLowerCase());
                    document.querySelectorAll(
                        '.ldr-log-filter .ldr-filter-buttons button')
                        .forEach((b) => b.classList.remove('ldr-selected'));
                    btn.classList.add('ldr-selected');
                    filterLogs(type);
                });
            });
        // Autoscroll button.
        const autoBtn = document.getElementById('log-autoscroll-button');
        if (autoBtn) {
            autoBtn.addEventListener('click', () => {
                state.autoscroll = !state.autoscroll;
                autoBtn.classList.toggle('ldr-selected', state.autoscroll);
                if (state.autoscroll && c) c.scrollTop = 0;
            });
        }
        // Pre-fetch on init so the first expand is instant — and so
        // the empty-response → first-rows race self-heals when the
        // backend flushes its first persist.
        if (researchId && !panelEl.dataset.loaded) loadLogs(researchId);
        // URL-hash entry points. These used to use setTimeout(500/800)
        // to defer past DOMContentLoaded's other init work, but the
        // panel is now explicitly expanded by the toggleEl click only
        // when needed (no auto-deferral required for the test runner).
        if (window.location.hash === '#logs' && researchId) {
            toggleEl.click();
        }
        if (window.location.search.includes('debug=logs') ||
            window.location.hash.includes('debug')) {
            if (panelEl.classList.contains('collapsed')) toggleEl.click();
        }
        // Global API for backwards compatibility.
        window.addConsoleLog = addLog;
        window.filterLogsByType = filterLogs;
        window._socketAddLogEntry = function(raw) {
            const time = raw.time || new Date().toISOString();
            const type = raw.type || (raw.metadata && raw.metadata.type) || 'info';
            const serverId = raw.id ?? (raw.metadata && raw.metadata.id);
            const entry = {
                id: serverId != null && serverId !== ''
                    ? String(serverId)
                    : `${time}-${hashString(raw.message || raw.content || '')}`,
                time,
                message: raw.message || raw.content || '',
                type: String(type).toLowerCase(),
                // Preserve original casing so the rendered badge matches
                // the raw severity ("CRITICAL", not "Critical").
                level: type,
                metadata: raw.metadata || {},
            };
            insertLive(entry, true);
        };
    }

    // ─── Public API ──────────────────────────────────────────────────────

    window.logPanel = {
        initialize: initializeLogPanel,
        addLog,
        filterLogs,
        loadLogs,
        _pruneToCap: pruneToCap,
        // Exposed for tests that mutate state directly and need to
        // repaint the header (button visibility, indicator text)
        // without going through a full loadLogs() round-trip.
        _renderHeader: renderHeader,
    };

    // Auto-init on DOMContentLoaded: pull the research id from the URL
    // (paths under /progress/ or /results/ carry it; /chat/ pages don't
    // and initialize() with null is a no-op until the chat layer calls
    // back with a real id).
    //
    // The page type also decides whether to use the priority-diagnostic
    // log bias:
    //   - /progress/ → priority on (research is running; we want errors
    //     and warnings surfaced above routine noise).
    //   - /results/ → priority off (research is complete; the user wants
    //     the actual newest N rows, not a triage list).
    //   - /chat/    → priority on (chat shows a live research session).
    document.addEventListener('DOMContentLoaded', () => {
        const urlMatch = window.location.pathname
            .match(/\/(progress|results|chat)\/([a-zA-Z0-9-]+)/);
        const researchId = urlMatch ? urlMatch[2] : null;
        const pageType = urlMatch ? urlMatch[1] : null;
        if (!isResearchPage()) return;
        const isLive = pageType === 'results' ? false : true;
        initializeLogPanel(researchId, { isLive });
    });
})();
