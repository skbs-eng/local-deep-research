/**
 * Tests for components/logpanel.js
 *
 * Verifies fixes for the "blank log panel on first load" bug:
 *   1. When the logs API returns [], loadLogsForResearch must not
 *      overwrite live entries that arrived via socket events during
 *      the fetch.
 *   2. dataset.loaded must NOT be set after an empty API response, so
 *      a future toggle (or pre-fetch) re-fetches.
 *   3. dataset.loaded IS set after a successful non-empty fetch, so
 *      subsequent toggles don't re-fetch.
 *   4. When the API returns entries while live socket entries already
 *      exist, the fetched batch is merged via addLogEntryToPanel
 *      (which dedupes) instead of clobbering with innerHTML.
 */

let logPanel;
let emptyCounts;

beforeAll(async () => {
    // logpanel.js destructures window.LdrLogHelpers at IIFE-time.
    await import('@js/utils/log-helpers.js');

    // log-helpers.js is an IIFE that only exposes its surface via
    // window.LdrLogHelpers — it has no module exports, so we can't
    // destructure from the import. Wire the helper through window
    // so the beforeEach below can call it.
    emptyCounts = window.LdrLogHelpers.emptyCounts;

    // Stubs the IIFE expects to find on window.
    window.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, '');
    window.URLBuilder = {
        researchLogs: (id, limit) =>
            `/api/research/${id}/logs${limit ? `?limit=${limit}` : ''}`,
        researchLogsAll: (id, limit) =>
            `/api/research/${id}/logs/all${limit ? `?limit=${limit}` : ''}`,
        researchLogsWarningsErrors: (id) =>
            `/api/research/${id}/logs/warnings-errors`,
        historyLogCount: (id) => `/api/research/${id}/log_count`,
        researchLogsExport: (id) => `/api/research/${id}/logs/export`,
    };

    // Pretend we're on a research page so the auto-initialize path runs.
    // Spread doesn't copy non-enumerable props off the Location prototype, so
    // explicitly include `search` and `hash` — initializeLogPanel reads them
    // for its debug-flag check (logpanel.js:321).
    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, pathname: '/', search: '', hash: '' },
    });

    await import('@js/components/logpanel.js');
    logPanel = window.logPanel;
});

beforeEach(() => {
    // Build the minimal DOM the panel queries by id.
    document.body.innerHTML = `
        <div class="ldr-collapsible-log-panel">
            <div id="log-panel-toggle">
                <i class="ldr-toggle-icon"></i>
            </div>
            <div id="log-panel-content">
                <div id="console-log-container"></div>
            </div>
        </div>
        <template id="console-log-entry-template">
            <div class="ldr-console-log-entry">
                <span class="ldr-log-timestamp"></span>
                <span class="ldr-log-badge"></span>
                <span class="ldr-log-message"></span>
            </div>
        </template>
    `;

    // Reset shared state between tests.
    if (window._logPanelState) {
        window._logPanelState.queuedLogs = [];
        window._logPanelState.expanded = false;
        window._logPanelState.logCount = 0;
        window._logPanelState.counts = emptyCounts();
        window._logPanelState.currentFilter = 'all';
        window._logPanelState.autoscroll = true;
        // Force re-binding of click handlers in tests that call initialize();
        // tests that only exercise loadLogs/addLog don't rely on this.
        window._logPanelState.renderedIds = new Set();
        window._logPanelState.initialized = false;
        window._logPanelState.connectedResearchId = null;
        window._logPanelState.totalLogs = null;
        window._logPanelState.fetchedLogs = null;
        window._logPanelState.renderedLimit = null;
        window._logPanelState.oldestLoadedId = null;
        window._logPanelState.newestLoadedId = null;
        window._logPanelState.viewOffset = 0;
        window._logPanelState.viewWindowSize = 500;
        window._logPanelState.usePriorityDiagnostic = true;
        window._logPanelState.isLive = true;
        window._logPanelState.cumulativeCounts = emptyCounts();
        window._logPanelState.cumulativeTotal = 0;
        window._logPanelState.hasPagedBack = false;
        window._logPanelState.loadNewerExhausted = false;
        window._logPanelState._countRequestGen = 0;
        window._logPanelState.inflight = new Set();
        window._logPanelState.warningsErrorsEntries = [];
        window._logPanelState.warningsErrorsIds = new Set();
    }
});

/**
 * Build the full log-panel DOM (filter buttons, autoscroll button, etc.)
 * inside an optional research-page wrapper, then call logPanel.initialize so
 * the click handlers from initializeLogPanel get bound.
 *
 * @param {Object} opts
 * @param {'progress'|'results'|null} [opts.page] - Wrap the panel in a
 *   research page container so initializeLogPanel sees a research page.
 *   'progress' makes the toggle handler take the new CSS-flex branch from
 *   PR #3851; 'results' takes the legacy autoscroll-hide branch.
 * @param {string} [opts.researchId] - Passed through to initialize();
 *   each call uses a fresh ID to bypass the same-ID early return.
 */
function setupPanelDom({ page = 'progress', researchId } = {}) {
    // Reset the document body, then optionally wrap the panel in a research
    // page container so initializeLogPanel sees a research page.
    document.body.innerHTML = `
        <div class="ldr-collapsible-log-panel">
            <div class="ldr-log-panel-header" id="log-panel-toggle">
                <i class="fas fa-chevron-right ldr-toggle-icon"></i>
            </div>
            <div class="ldr-log-panel-content collapsed" id="log-panel-content">
                <div class="ldr-log-controls">
                    <div class="ldr-log-filter">
                        <div class="ldr-filter-buttons">
                            <button class="ldr-small-btn ldr-selected" data-filter-type="all" onclick="window.filterLogsByType('all')">All <span class="ldr-filter-count" data-filter-count="all">0</span></button>
                            <button class="ldr-small-btn" data-filter-type="milestone" onclick="window.filterLogsByType('milestone')">Milestones <span class="ldr-filter-count" data-filter-count="milestone">0</span></button>
                            <button class="ldr-small-btn" data-filter-type="info" onclick="window.filterLogsByType('info')">Info <span class="ldr-filter-count" data-filter-count="info">0</span></button>
                            <button class="ldr-small-btn" data-filter-type="warning" onclick="window.filterLogsByType('warning')">Warning <span class="ldr-filter-count" data-filter-count="warning">0</span></button>
                            <button class="ldr-small-btn" data-filter-type="error" onclick="window.filterLogsByType('error')">Errors <span class="ldr-filter-count" data-filter-count="error">0</span></button>
                        </div>
                    </div>
                    <button id="log-autoscroll-button" class="ldr-selected"></button>
                    <button id="log-download-button"></button>
                </div>
                <div class="ldr-console-log" id="console-log-container"></div>
            </div>
        </div>
        <template id="console-log-entry-template">
            <div class="ldr-console-log-entry">
                <span class="ldr-log-timestamp"></span>
                <span class="ldr-log-badge"></span>
                <span class="ldr-log-message"></span>
            </div>
        </template>
    `;

    if (page === 'progress' || page === 'results') {
        const wrapper = document.createElement('div');
        wrapper.id = page === 'progress' ? 'research-progress' : 'research-results';
        const panel = document.querySelector('.ldr-collapsible-log-panel');
        document.body.insertBefore(wrapper, panel);
        wrapper.appendChild(panel);
    }

    // Each test uses a fresh research ID so initialize() doesn't short-circuit
    // on the same-ID check at logpanel.js:44.
    if (researchId !== null) {
        const rid = researchId || `rid-${Math.random().toString(36).slice(2)}`;
        logPanel.initialize(rid);
    }
}

function makeLiveEntry(message, type = 'info') {
    // Mimic what addLogEntryToPanel produces in the DOM. The optional
    // `type` argument lets the per-category prune tests seed entries
    // of a specific category into the container directly.
    const entry = document.createElement('div');
    entry.className = 'ldr-console-log-entry';
    entry.dataset.logId = `live-${message}`;
    entry.dataset.logType = type;
    const span = document.createElement('span');
    span.className = 'ldr-log-message';
    span.textContent = message;
    entry.appendChild(span);
    return entry;
}

describe('loadLogsForResearch — empty API response', () => {
    it('does not clobber live socket-driven entries when API returns []', async () => {
        const container = document.getElementById('console-log-container');
        container.appendChild(makeLiveEntry('socket-arrived-A'));
        container.appendChild(makeLiveEntry('socket-arrived-B'));

        // Simulate empty API response.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );

        await logPanel.loadLogs('test-research-1');

        // Live entries must still be in the DOM.
        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(2);
        // The empty-state placeholder must NOT have replaced them.
        expect(container.querySelector('.ldr-empty-log-message')).toBeNull();
    });

    it('writes the empty placeholder when the container has no live entries', async () => {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );

        await logPanel.loadLogs('test-research-2');

        const container = document.getElementById('console-log-container');
        expect(container.querySelector('.ldr-empty-log-message')).not.toBeNull();
    });

    it('does not set dataset.loaded after an empty response', async () => {
        const panelContent = document.getElementById('log-panel-content');
        // Pretend a previous successful load set this.
        delete panelContent.dataset.loaded;

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );

        await logPanel.loadLogs('test-research-3');

        // Empty response must leave dataset.loaded unset so a retry can happen.
        expect(panelContent.dataset.loaded).toBeUndefined();
    });

    it('resets stale category counters when an empty response leaves only a placeholder', async () => {
        const indicator = document.createElement('span');
        indicator.className = 'ldr-log-indicator';
        indicator.textContent = '9';
        document.getElementById('log-panel-toggle').appendChild(indicator);
        const badge = document.createElement('span');
        badge.className = 'ldr-filter-count';
        badge.dataset.filterCount = 'warning';
        badge.textContent = '9';
        document.body.appendChild(badge);
        window._logPanelState.counts.warning = 9;

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );

        await logPanel.loadLogs('test-research-empty-counters');

        expect(window._logPanelState.counts).toEqual(emptyCounts());
        expect(indicator.textContent).toBe('0');
        expect(badge.textContent).toBe('0');
    });
});

describe('loadLogsForResearch — non-empty API response', () => {
    it('sets dataset.loaded after a successful non-empty fetch', async () => {
        const panelContent = document.getElementById('log-panel-content');

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () =>
                    Promise.resolve([
                        { timestamp: new Date().toISOString(), message: 'hello', log_type: 'info' },
                    ]),
            })
        );

        await logPanel.loadLogs('test-research-4');

        expect(panelContent.dataset.loaded).toBe('true');
    });

    it('merges via addLogEntryToPanel when live entries already exist', async () => {
        const container = document.getElementById('console-log-container');
        container.appendChild(makeLiveEntry('live-only'));

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () =>
                    Promise.resolve([
                        { timestamp: new Date().toISOString(), message: 'fetched', log_type: 'info' },
                    ]),
            })
        );

        await logPanel.loadLogs('test-research-5');

        // The live entry must survive (not overwritten by innerHTML reset).
        const messages = Array.from(
            container.querySelectorAll('.ldr-log-message')
        ).map((el) => el.textContent);
        expect(messages).toContain('live-only');
    });
});

describe('loadLogsForResearch — in-flight deduplication', () => {
    it('skips a duplicate fetch while one is already in flight', async () => {
        // Hold the first fetch open until we explicitly resolve it, so the
        // second call lands while the first is still pending.
        let resolveFirst;
        const firstResponse = new Promise((resolve) => {
            resolveFirst = resolve;
        });
        const fetchSpy = vi.fn(() => firstResponse);
        globalThis.fetch = fetchSpy;

        const firstCall = logPanel.loadLogs('test-research-dedup');
        // While first is in flight, kick off a second call — it must be a no-op.
        const secondCall = logPanel.loadLogs('test-research-dedup');
        await secondCall;

        // Only one fetch should have happened so far. loadLogsForResearch
        // makes 2 fetches today (log_count + logs) but the in-flight guard
        // kicks in BEFORE the second fetch is even attempted — both fetches
        // share the same panelEl.dataset.loading flag, set synchronously at
        // the top of loadLogsForResearch, so the second call returns without
        // any fetch happening.
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Resolve the first call so it can finish cleanly.
        resolveFirst({ json: () => Promise.resolve([]) });
        await firstCall;
    });

    it('clears the in-flight flag after completion so future calls can run', async () => {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );

        await logPanel.loadLogs('test-research-cleared-1');
        // Second call after the first completes must execute (not be deduped).
        await logPanel.loadLogs('test-research-cleared-2');

        // 3 fetch calls per loadLogs (log_count + logs +
        // /logs/warnings-errors for the live panel's dedicated
        // diagnostics feed). Two completed calls => 6.
        expect(globalThis.fetch).toHaveBeenCalledTimes(6);
    });

    it('clears dataset.loading even when fetch rejects', async () => {
        // If a refactor drops the `finally` block that clears
        // dataset.loading, a single network error would permanently lock
        // the panel into "skipping duplicate" mode for the rest of the
        // page lifetime — exactly the silent-blank-panel class of bug
        // this PR is fixing.
        const panelContent = document.getElementById('log-panel-content');
        globalThis.fetch = vi.fn(() => Promise.reject(new Error('net down')));

        await logPanel.loadLogs('test-research-throws');

        expect(panelContent.dataset.loading).toBeUndefined();

        // A follow-up call must actually fire fetch again, not be deduped.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );
        await logPanel.loadLogs('test-research-throws');
        // 3 fetch calls per loadLogs (log_count + logs +
        // /logs/warnings-errors for the live panel's dedicated
        // diagnostics feed).
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('resets stale counters when a load error replaces the log DOM', async () => {
        const indicator = document.createElement('span');
        indicator.className = 'ldr-log-indicator';
        indicator.textContent = '4';
        document.getElementById('log-panel-toggle').appendChild(indicator);
        window._logPanelState.counts.error = 4;
        globalThis.fetch = vi.fn(() => Promise.reject(new Error('net down')));

        await logPanel.loadLogs('test-research-error-counters');

        expect(document.querySelector('.ldr-error-message')).not.toBeNull();
        expect(window._logPanelState.counts).toEqual(emptyCounts());
        expect(indicator.textContent).toBe('0');
    });
});

describe('addConsoleLog — placeholder removal', () => {
    it('removes the empty-state placeholder when adding a live entry', () => {
        const container = document.getElementById('console-log-container');
        container.innerHTML =
            '<div class="ldr-empty-log-message">No logs available.</div>';

        // Force the panel into an expanded state so addConsoleLog goes
        // straight to addLogEntryToPanel rather than queuing.
        window._logPanelState.expanded = true;

        logPanel.addLog('first live log', 'info');

        // Placeholder is gone, real entry took its place.
        expect(container.querySelector('.ldr-empty-log-message')).toBeNull();
        expect(container.querySelector('.ldr-console-log-entry')).not.toBeNull();
    });
});

// Ordering invariants for the #2610 fix (PR #3850). The log panel uses
// `flex-direction: column-reverse` so DOM end == visual top. happy-dom
// does not render CSS, so these tests assert on DOM order directly --
// the contract being locked in is "DOM order is chronological
// oldest -> newest", and the CSS flip is taken as given.
//
// Mirrors of source-side constants (kept inline because both are `const`
// inside the IIFE in logpanel.js and not exported). If either source
// constant changes, update here:
//   MAX_LOG_ENTRIES   src/local_deep_research/web/static/js/components/logpanel.js:21
//   DEDUP_WINDOW      src/local_deep_research/web/static/js/components/logpanel.js
//                     (the `existingEntries.length - 10` lower bound in
//                      addLogEntryToPanel's dedup-by-content scan)
const MAX_LOG_ENTRIES = 500;
const DEDUP_WINDOW = 10;

describe('addLog / loadLogs — ordering invariants', () => {
    function messageTextsInDomOrder(container) {
        return Array.from(container.querySelectorAll('.ldr-log-message')).map(
            (el) => el.textContent
        );
    }

    beforeEach(() => {
        // Drive entries through addLogEntryToPanel rather than the queue.
        window._logPanelState.expanded = true;
        // Fake all timers so ``vi.setSystemTime`` controls the wall clock
        // used by ``addLog`` (it produces ``time = new Date().toISOString()``
        // when no metadata is supplied). The autoscroll ``setTimeout(_, 0)``
        // that earlier revisions relied on has since been inlined to a
        // synchronous ``container.scrollTop = 0`` so no timer pileup
        // happens here any more.
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Drop any faked-timer state before switching back to real
        // timers, so they don't leak into a subsequent test.
        vi.clearAllTimers();
        vi.useRealTimers();
        // Vitest isolates globals between files, but ordering changes
        // within this file should not expose latent reliance on a prior
        // test's fetch mock.
        delete globalThis.fetch;
    });

    it('inserts live entries in chronological DOM order (newest at DOM end)', () => {
        const container = document.getElementById('console-log-container');

        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('first', 'info');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('second', 'info');
        vi.setSystemTime(new Date('2026-05-08T12:00:02Z'));
        logPanel.addLog('third', 'info');

        expect(messageTextsInDomOrder(container)).toEqual([
            'first',
            'second',
            'third',
        ]);

        // data-log-time-ms must be monotonically non-decreasing oldest -> newest.
        const times = Array.from(
            container.querySelectorAll('.ldr-console-log-entry')
        ).map((el) => Number(el.dataset.logTimeMs));
        expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('merges late-arriving older history into chronological position', async () => {
        const container = document.getElementById('console-log-container');

        // Two live entries arrive first (recent times).
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('live-A', 'info');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('live-B', 'info');

        // Then loadLogs returns one historical entry whose timestamp is
        // older than both live entries. The merge path routes through
        // addLogEntryToPanel, which must insert it before live-A.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () =>
                    Promise.resolve([
                        {
                            timestamp: '2026-05-08T11:59:00Z',
                            message: 'historical',
                            log_type: 'info',
                        },
                    ]),
            })
        );

        await logPanel.loadLogs('test-research-ordering-merge');

        expect(messageTextsInDomOrder(container)).toEqual([
            'historical',
            'live-A',
            'live-B',
        ]);
    });

    // Explicit per-test timeout: 501 inserts each run addLogEntryToPanel's
    // full-container querySelectorAll scans (dedup window, chronological
    // insert position, prune check) — O(n²) DOM work that takes
    // ~2.6-2.9s in happy-dom on a dev machine. The vitest default 5s
    // leaves no headroom under parallel CI load. The autoscroll
    // ``setTimeout(_, 0)`` that earlier revisions piled up no longer
    // runs (the scrollTop assignment is now synchronous), so this is
    // honest compute — a bigger per-test budget is the right lever.
    // The test must fill to the real MAX_LOG_ENTRIES cap to exercise
    // the prune; the work can't be reduced without weakening the
    // assertion.
    it('drops the oldest info entry when the cap is exceeded by info-only inserts', { timeout: 20000 }, () => {
        const container = document.getElementById('console-log-container');

        // One insert over the cap. The live-insert prune in
        // addLogEntryToPanel must drop the oldest entry, not the newest.
        const totalInserts = MAX_LOG_ENTRIES + 1;
        const base = new Date('2026-05-08T12:00:00Z').getTime();
        for (let i = 0; i < totalInserts; i++) {
            vi.setSystemTime(new Date(base + i * 1000));
            logPanel.addLog(`msg-${i}`, 'info');
        }

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(MAX_LOG_ENTRIES);

        const messages = messageTextsInDomOrder(container);
        // Oldest (msg-0) was pruned; msg-1 is now the oldest in DOM,
        // msg-${totalInserts - 1} is the newest.
        expect(messages).not.toContain('msg-0');
        expect(messages[0]).toBe('msg-1');
        expect(messages[messages.length - 1]).toBe(`msg-${totalInserts - 1}`);
    });

    it('dedupes a duplicate inside the 10-newest window', () => {
        const container = document.getElementById('console-log-container');

        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('dup-msg', 'info');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('dup-msg', 'info');

        // Only one DOM entry, with a duplicate-counter badge.
        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(1);
        expect(entries[0].dataset.counter).toBe('2');
        const badge = entries[0].querySelector('.ldr-duplicate-counter');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('(2×)');
    });

    it('does not dedupe a duplicate that has fallen outside the 10-newest window', () => {
        const container = document.getElementById('console-log-container');

        // DEDUP_WINDOW + 1 distinct messages: msg-0 ends up at DOM index 0
        // (oldest), msg-${DEDUP_WINDOW} at the newest end. The
        // dedup-by-content scan only covers the DEDUP_WINDOW newest, so
        // msg-0 is one slot outside it.
        const distinctCount = DEDUP_WINDOW + 1;
        const base = new Date('2026-05-08T12:00:00Z').getTime();
        for (let i = 0; i < distinctCount; i++) {
            vi.setSystemTime(new Date(base + i * 1000));
            logPanel.addLog(`msg-${i}`, 'info');
        }

        // Re-add msg-0 with a fresh timestamp so dedup-by-id misses
        // (different id -> ${timestamp}-${hash}). Dedup-by-content would
        // catch it only if msg-0 were in the DEDUP_WINDOW newest.
        vi.setSystemTime(new Date(base + distinctCount * 1000));
        logPanel.addLog('msg-0', 'info');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(distinctCount + 1);

        // The two msg-0 entries sit at the chronological extremes.
        const messages = messageTextsInDomOrder(container);
        expect(messages[0]).toBe('msg-0');
        expect(messages[messages.length - 1]).toBe('msg-0');
    });
});

// Content-dedup applies only to info entries. Warning / error / milestone
// entries are diagnostic — collapsing repeated retries or repeated failures
// into a single `(N×)` counter strips the recency signal (you can no longer
// tell *when* the last failure happened) and hides forward progress. The
// id-based dedup upstream still catches exact retransmits with the same id
// for those categories; this describe block locks in the content-dedup
// bypass for non-info.
describe('addLog — content dedup bypass for non-info categories', () => {
    let container;

    function messageTextsInDomOrder(c) {
        return Array.from(c.querySelectorAll('.ldr-log-message')).map(
            (el) => el.textContent
        );
    }

    beforeEach(() => {
        container = document.getElementById('console-log-container');
        window._logPanelState.expanded = true;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('inserts two identical warning entries without collapsing them', () => {
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('retry-failed', 'warning');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('retry-failed', 'warning');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(2);
        // Each entry stays at the initial counter of 1 (no increment).
        // The `(2×)` badge is the dedup-collapse signal — it must be
        // absent because the bypass path doesn't touch the dedup scan.
        entries.forEach((entry) => {
            expect(entry.dataset.counter).toBe('1');
            expect(entry.querySelector('.ldr-duplicate-counter')).toBeNull();
        });
        const messages = messageTextsInDomOrder(container);
        expect(messages).toEqual(['retry-failed', 'retry-failed']);
    });

    it('inserts two identical error entries without collapsing them', () => {
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('lookup failed', 'error');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('lookup failed', 'error');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(2);
        entries.forEach((entry) => {
            expect(entry.dataset.counter).toBe('1');
            expect(entry.querySelector('.ldr-duplicate-counter')).toBeNull();
        });
        const messages = messageTextsInDomOrder(container);
        expect(messages).toEqual(['lookup failed', 'lookup failed']);
    });

    it('still collapses repeated info entries into a (N×) badge', () => {
        // Regression guard: the dedup bypass must not accidentally disable
        // dedup for info entries, which is what motivated the loop in the
        // first place.
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('heartbeat', 'info');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('heartbeat', 'info');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(1);
        // Counter increments to 2 because the second addLog took the dedup
        // branch and incremented the existing entry's counter.
        expect(entries[0].dataset.counter).toBe('2');
        const badge = entries[0].querySelector('.ldr-duplicate-counter');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('(2×)');
    });

    it('still inserts each milestone entry independently', () => {
        // Pre-existing contract: identical milestones already had a
        // `logType !== 'milestone'` guard inside the dedup scan, so they
        // already rendered twice. The new bypass keeps that behavior.
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('research started', 'milestone');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('research started', 'milestone');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(2);
        entries.forEach((entry) => {
            // No counter increment, no `(2×)` badge.
            expect(entry.dataset.counter).toBe('1');
            expect(entry.querySelector('.ldr-duplicate-counter')).toBeNull();
        });
    });

    it('bypass holds even when warnings share a recent message with a preceding info', () => {
        // Defensive: the dedup scan keys on both message *and* logType, so
        // a warning with the same text as a recent info would not have
        // been caught by the old scan either. This locks in the explicit
        // no-dedup for non-info regardless of what is in the recent window.
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('connection refused', 'info');
        vi.setSystemTime(new Date('2026-05-08T12:00:01Z'));
        logPanel.addLog('connection refused', 'warning');
        vi.setSystemTime(new Date('2026-05-08T12:00:02Z'));
        logPanel.addLog('connection refused', 'warning');

        // All three survive; neither warning has the dedup badge.
        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(3);

        const infoEntry = entries[0];
        expect(infoEntry.dataset.logType).toBe('info');
        expect(infoEntry.dataset.counter).toBe('1');
        expect(infoEntry.querySelector('.ldr-duplicate-counter')).toBeNull();

        const warningEntries = [entries[1], entries[2]];
        warningEntries.forEach((entry) => {
            expect(entry.dataset.logType).toBe('warning');
            expect(entry.dataset.counter).toBe('1');
            expect(entry.querySelector('.ldr-duplicate-counter')).toBeNull();
        });
    });
});

describe('loadLogsForResearch — progress_log content dedup', () => {
    function progressEntry(message, time, metadata = {}) {
        return { message, time, metadata };
    }

    async function loadProgressLogs(entries) {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () =>
                    Promise.resolve({
                        progress_log: JSON.stringify(entries),
                    }),
            })
        );
        await logPanel.loadLogs('progress-log-dedup');
        return document.querySelectorAll('.ldr-console-log-entry');
    }

    it('keeps identical error progress entries within one minute', async () => {
        const entries = await loadProgressLogs([
            progressEntry('request failed', '2026-05-08T12:00:00Z', {
                phase: 'error',
            }),
            progressEntry('request failed', '2026-05-08T12:00:01Z', {
                phase: 'error',
            }),
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).map((entry) => entry.dataset.logType)).toEqual([
            'error',
            'error',
        ]);
    });

    it('keeps identical milestone progress entries within one minute', async () => {
        const entries = await loadProgressLogs([
            progressEntry('iteration complete', '2026-05-08T12:00:00Z', {
                phase: 'complete',
            }),
            progressEntry('iteration complete', '2026-05-08T12:00:01Z', {
                phase: 'complete',
            }),
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).map((entry) => entry.dataset.logType)).toEqual([
            'milestone',
            'milestone',
        ]);
    });

    it('still collapses identical info progress entries within one minute', async () => {
        const entries = await loadProgressLogs([
            progressEntry('searching sources', '2026-05-08T12:00:00Z'),
            progressEntry('searching sources', '2026-05-08T12:00:01Z'),
        ]);

        expect(entries).toHaveLength(1);
        expect(entries[0].dataset.logType).toBe('info');
    });

    it('keeps identical info progress entries more than one minute apart', async () => {
        const entries = await loadProgressLogs([
            progressEntry('searching sources', '2026-05-08T12:00:00Z'),
            progressEntry('searching sources', '2026-05-08T12:01:01Z'),
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).every((entry) =>
            entry.dataset.logType === 'info'
        )).toBe(true);
    });
});

describe('loadLogsForResearch — standard-array content dedup', () => {
    function standardEntry(message, time, logType = 'info') {
        return { timestamp: time, message, log_type: logType };
    }

    async function loadStandardLogs(entries) {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve(entries),
            })
        );
        await logPanel.loadLogs('standard-array-dedup');
        return document.querySelectorAll('.ldr-console-log-entry');
    }

    it('preserves explicit info severity when the message mentions errors or failures', async () => {
        const entries = await loadStandardLogs([
            standardEntry(
                'Researching error handling and failed-request recovery requirements',
                '2026-05-08T12:00:00Z',
                'INFO'
            ),
        ]);

        expect(entries).toHaveLength(1);
        expect(entries[0].dataset.logType).toBe('info');
    });

    it('infers error severity for legacy entries without level metadata', async () => {
        const entries = await loadStandardLogs([
            {
                timestamp: '2026-05-08T12:00:00Z',
                message: 'request failed during processing',
            },
        ]);

        expect(entries).toHaveLength(1);
        expect(entries[0].dataset.logType).toBe('error');
    });

    it('keeps identical error standard entries within one minute', async () => {
        const entries = await loadStandardLogs([
            standardEntry('request failed', '2026-05-08T12:00:00Z', 'error'),
            standardEntry('request failed', '2026-05-08T12:00:01Z', 'error'),
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).map((entry) => entry.dataset.logType)).toEqual([
            'error',
            'error',
        ]);
    });

    it('keeps identical milestone standard entries within one minute', async () => {
        const entries = await loadStandardLogs([
            standardEntry('iteration complete', '2026-05-08T12:00:00Z', 'milestone'),
            standardEntry('iteration complete', '2026-05-08T12:00:01Z', 'milestone'),
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).map((entry) => entry.dataset.logType)).toEqual([
            'milestone',
            'milestone',
        ]);
    });

    it('still collapses identical info standard entries within one minute', async () => {
        const entries = await loadStandardLogs([
            standardEntry('searching sources', '2026-05-08T12:00:00Z'),
            standardEntry('searching sources', '2026-05-08T12:00:01Z'),
        ]);

        expect(entries).toHaveLength(1);
        expect(entries[0].dataset.logType).toBe('info');
    });

    it('keeps identical info standard entries more than one minute apart', async () => {
        const entries = await loadStandardLogs([
            standardEntry('searching sources', '2026-05-08T12:00:00Z'),
            standardEntry('searching sources', '2026-05-08T12:01:01Z'),
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).every((entry) =>
            entry.dataset.logType === 'info'
        )).toBe(true);
    });

    it('keeps distinct persisted rows with identical timestamp and message when the server provides stable ids', async () => {
        // Mirrors the real /api/research/<id>/logs response contract:
        // top-level array of {id, message, timestamp, log_type}, where
        // id is a stable database row id and the server orders equal
        // timestamps by it. Two distinct rows must survive into the
        // rendered DOM even when their (timestamp, message) tuples
        // collide. log_type is uppercase to verify metadata-first
        // classification; the message text is deliberately neutral so
        // it does NOT trigger the keyword fallback (no "error",
        // "failed", "complete", "finished", "starting phase",
        // "generated report").
        const entries = await loadStandardLogs([
            {
                id: 1042,
                message: 'Service unavailable',
                timestamp: '2026-05-08T12:00:00Z',
                log_type: 'ERROR',
            },
            {
                id: 1043,
                message: 'Service unavailable',
                timestamp: '2026-05-08T12:00:00Z',
                log_type: 'ERROR',
            },
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).map((entry) => entry.dataset.logType)).toEqual([
            'error',
            'error',
        ]);
        // Order-independent assertion: with identical timestamps the
        // batch loader's reverse-iteration insert produces a stable
        // but implementation-defined ordering — the contract under
        // test is that BOTH rows survive, not the exact slot.
        expect(Array.from(entries).map((entry) => entry.dataset.logId)
            .sort()).toEqual(['1042', '1043']);
    });

    it('keeps distinct persisted milestone rows with identical timestamp and message when the server provides stable ids', async () => {
        // Same production contract as above, but for MILESTONE-class
        // rows with a neutral message ("phase change") that the
        // keyword heuristic would leave alone. Locking both severities
        // in pins the full uniqueLogsMap contract: ids are the
        // canonical key once the server supplies them, and metadata
        // (not keyword matching) decides the category.
        const entries = await loadStandardLogs([
            {
                id: 'row-a',
                message: 'Phase change acknowledged',
                timestamp: '2026-05-08T12:00:00Z',
                log_type: 'MILESTONE',
            },
            {
                id: 'row-b',
                message: 'Phase change acknowledged',
                timestamp: '2026-05-08T12:00:00Z',
                log_type: 'MILESTONE',
            },
        ]);

        expect(entries).toHaveLength(2);
        expect(Array.from(entries).map((entry) => entry.dataset.logType)).toEqual([
            'milestone',
            'milestone',
        ]);
        expect(Array.from(entries).map((entry) => entry.dataset.logId)
            .sort()).toEqual(['row-a', 'row-b']);
    });

    it('keeps distinct persisted error rows when an outlier date forces normalizeTimestamps to re-stamp their times', async () => {
        // Crosses normalizeTimestamps and the final uniqueLogsMap dedup:
        // five rows in, three on the majority date and two outliers on a
        // different day. Without the "preserve existing id" guard in
        // normalizeTimestamps, the two outlier rows are re-keyed to the
        // same `${time}-${hash(message)}` string (their timestamps and
        // messages are identical post-normalization), so the uniqueLogsMap
        // collapses one of them and only four rows reach the DOM. The
        // production probe cited in review rendered four from five; the
        // fix must produce five. log_type is uppercase and the message is
        // deliberately neutral so neither path relies on the keyword
        // fallback.
        const majorityTime = '2026-05-08T12:00:00Z';
        const outlierTime = '2026-05-09T12:00:00Z';
        const sharedMessage = 'Service unavailable';
        const entries = await loadStandardLogs([
            { id: 'row-one', message: sharedMessage, timestamp: majorityTime, log_type: 'ERROR' },
            { id: 'row-two', message: sharedMessage, timestamp: majorityTime, log_type: 'ERROR' },
            { id: 'row-three', message: sharedMessage, timestamp: majorityTime, log_type: 'ERROR' },
            { id: 'row-four', message: sharedMessage, timestamp: outlierTime, log_type: 'ERROR' },
            { id: 'row-five', message: sharedMessage, timestamp: outlierTime, log_type: 'ERROR' },
        ]);

        expect(entries).toHaveLength(5);
        expect(Array.from(entries).every((entry) =>
            entry.dataset.logType === 'error'
        )).toBe(true);
        // Order-independent: uniqueLogsMap + the batch loader's reverse
        // iteration produce a stable but implementation-defined ordering
        // for ties. The contract under test is that all five server ids
        // survive normalization + dedup and reach the DOM.
        expect(Array.from(entries).map((entry) => entry.dataset.logId)
            .sort()).toEqual([
            'row-five', 'row-four', 'row-one', 'row-three', 'row-two',
        ]);
    });
});

/**
 * Toggle handler tests — locks in the contract introduced by PR #3851.
 *
 * The fix replaced a JS height calc with a CSS flex layout scoped to
 * `#research-progress`. The toggle handler now toggles a `.ldr-expanded`
 * class and clears any inline `style.height` on the progress page; on
 * non-progress pages it falls back to `style.height = 'auto'` and hides the
 * autoscroll button. These tests guard against a future refactor silently
 * re-introducing a JS-driven height formula or dropping the autoscroll-hide
 * branch.
 *
 * Note: CSS layout (no scrollbar at viewport heights, panel fills available
 * space) cannot be validated in happy-dom and remains a manual browser check.
 */
describe('toggle handler — progress page', () => {
    it('toggles .ldr-expanded on/off across two clicks', () => {
        setupPanelDom({ page: 'progress' });
        const panel = document.querySelector('.ldr-collapsible-log-panel');
        const toggle = document.getElementById('log-panel-toggle');

        toggle.click();
        expect(panel.classList.contains('ldr-expanded')).toBe(true);

        toggle.click();
        expect(panel.classList.contains('ldr-expanded')).toBe(false);
    });

    it('clears any inline style.height when expanding', () => {
        setupPanelDom({ page: 'progress' });
        const panel = document.querySelector('.ldr-collapsible-log-panel');
        // Simulate a stale inline height left over from the old JS-calc code
        // path. Expanding on a progress page must clear it so the new CSS
        // flex layout can size the panel.
        panel.style.height = '500px';

        document.getElementById('log-panel-toggle').click();

        expect(panel.style.height).toBe('');
    });

    it('enables autoscroll on first expand', () => {
        setupPanelDom({ page: 'progress' });

        document.getElementById('log-panel-toggle').click();

        // The handler sets autoscroll=false then calls toggleAutoscroll(),
        // which flips it to true. Locking this in guards against a refactor
        // that drops the toggleAutoscroll() call.
        expect(window._logPanelState.autoscroll).toBe(true);
    });
});

describe('toggle handler — non-progress page', () => {
    it('does not add .ldr-expanded when there is no #research-progress', () => {
        setupPanelDom({ page: 'results' });
        const panel = document.querySelector('.ldr-collapsible-log-panel');

        document.getElementById('log-panel-toggle').click();

        expect(panel.classList.contains('ldr-expanded')).toBe(false);
    });

    it('sets style.height to auto on expand', () => {
        setupPanelDom({ page: 'results' });
        const panel = document.querySelector('.ldr-collapsible-log-panel');

        document.getElementById('log-panel-toggle').click();

        expect(panel.style.height).toBe('auto');
    });

    it('hides the autoscroll button on expand', () => {
        setupPanelDom({ page: 'results' });

        document.getElementById('log-panel-toggle').click();

        const autoscrollButton = document.getElementById('log-autoscroll-button');
        expect(autoscrollButton.style.display).toBe('none');
    });
});

describe('filter buttons', () => {
    // Helper: locate a filter button via its inner count span instead of
    // its full textContent (which now includes the live count badge).
    const findButton = (filterType) =>
        document.querySelector(
            `.ldr-log-filter .ldr-filter-buttons button:has([data-filter-count="${filterType}"])`
        );

    it('moves .ldr-selected to the clicked button', () => {
        setupPanelDom({ page: 'progress' });
        const allBtn = findButton('all');
        const errorsBtn = findButton('error');
        expect(allBtn.classList.contains('ldr-selected')).toBe(true);

        errorsBtn.click();

        expect(allBtn.classList.contains('ldr-selected')).toBe(false);
        expect(errorsBtn.classList.contains('ldr-selected')).toBe(true);
    });

    it('updates _logPanelState.currentFilter to the clicked type', () => {
        setupPanelDom({ page: 'progress' });
        const errorsBtn = findButton('error');

        errorsBtn.click();

        // The data-filter-type attribute is the canonical source of
        // truth for the click handler now (so we don't have to parse
        // the button label, which includes the count badge text).
        expect(window._logPanelState.currentFilter).toBe('error');
    });

    it('hides entries whose log type does not match the filter', () => {
        setupPanelDom({ page: 'progress' });
        // Seed the container with one info and one error entry so we can
        // verify the filter actually toggles display on each.
        window._logPanelState.expanded = true;
        logPanel.addLog('an info message', 'info');
        logPanel.addLog('an error message', 'error');

        const container = document.getElementById('console-log-container');
        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(2);

        const errorsBtn = findButton('error');
        errorsBtn.click();

        const infoEntry = container.querySelector('.ldr-log-info');
        const errorEntry = container.querySelector('.ldr-log-error');
        expect(infoEntry.style.display).toBe('none');
        expect(errorEntry.style.display).toBe('');
    });

    it('groups Loguru aliases in filters, including rows added while active', () => {
        setupPanelDom({ page: 'progress', researchId: null });
        window._logPanelState.expanded = true;
        logPanel.addLog('critical-before-filter', 'CRITICAL');
        logPanel.addLog('fatal-before-filter', 'FATAL');
        logPanel.addLog('success-before-filter', 'SUCCESS');
        logPanel.addLog('info-before-filter', 'INFO');

        const critical = document.querySelector('.ldr-log-critical');
        const fatal = document.querySelector('.ldr-log-fatal');
        const success = document.querySelector('.ldr-log-success');
        const info = document.querySelector('.ldr-log-info');

        logPanel.filterLogs('error');
        expect(critical.style.display).toBe('');
        expect(fatal.style.display).toBe('');
        expect(success.style.display).toBe('none');
        expect(info.style.display).toBe('none');

        logPanel.filterLogs('warning');
        expect(critical.style.display).toBe('');
        expect(fatal.style.display).toBe('');
        expect(success.style.display).toBe('none');

        logPanel.filterLogs('milestone');
        expect(success.style.display).toBe('');
        expect(critical.style.display).toBe('none');
        expect(fatal.style.display).toBe('none');

        logPanel.filterLogs('error');
        logPanel.addLog('fatal-after-filter', 'FATAL');
        const lateFatal = Array.from(document.querySelectorAll(
            '.ldr-log-fatal'
        )).find((row) => row.querySelector(
            '.ldr-log-message'
        ).textContent === 'fatal-after-filter');
        expect(lateFatal.style.display).toBe('');
    });

    it("falls back to the button's label text (excluding the badge) when data-filter-type is missing", () => {
        // Regression guard for a code-review catch on #4898: the legacy
        // fallback used the full button.textContent, which now contains
        // the live count badge (e.g. "Errors 0"). That's not a valid
        // filter type and would slip through checkLogVisibility's
        // default (show everything). The fallback must read only the
        // label, so a legacy button labelled "Errors" still resolves
        // to the singular/plural-accepted 'errors' filter and works
        // as before.
        //
        // We build the DOM by hand here (instead of setupPanelDom) so
        // we can inject the legacy button *before* initialize() binds
        // click handlers — appending a button afterwards leaves it
        // un-handled and would exercise a never-reached path.
        document.body.innerHTML = `
            <div class="ldr-collapsible-log-panel">
                <div class="ldr-log-panel-header" id="log-panel-toggle">
                    <i class="fas fa-chevron-right ldr-toggle-icon"></i>
                </div>
                <div class="ldr-log-panel-content collapsed" id="log-panel-content">
                    <div class="ldr-log-controls">
                        <div class="ldr-log-filter">
                            <div class="ldr-filter-buttons">
                                <button class="ldr-small-btn ldr-selected" data-filter-type="all" onclick="window.filterLogsByType('all')">All <span class="ldr-filter-count" data-filter-count="all">0</span></button>
                                <button class="ldr-small-btn" data-filter-type="milestone" onclick="window.filterLogsByType('milestone')">Milestones <span class="ldr-filter-count" data-filter-count="milestone">0</span></button>
                                <button class="ldr-small-btn" data-filter-type="info" onclick="window.filterLogsByType('info')">Info <span class="ldr-filter-count" data-filter-count="info">0</span></button>
                                <button class="ldr-small-btn" data-filter-type="warning" onclick="window.filterLogsByType('warning')">Warning <span class="ldr-filter-count" data-filter-count="warning">0</span></button>
                            </div>
                        </div>
                        <button id="log-autoscroll-button" class="ldr-selected"></button>
                    </div>
                    <div class="ldr-console-log" id="console-log-container"></div>
                </div>
            </div>
            <template id="console-log-entry-template">
                <div class="ldr-console-log-entry">
                    <span class="ldr-log-timestamp"></span>
                    <span class="ldr-log-badge"></span>
                    <span class="ldr-log-message"></span>
                </div>
            </template>
        `;
        const wrapper = document.createElement('div');
        wrapper.id = 'research-progress';
        const panel = document.querySelector('.ldr-collapsible-log-panel');
        document.body.insertBefore(wrapper, panel);
        wrapper.appendChild(panel);

        // Inject the legacy button BEFORE initialize() runs so the
        // click handler in initializeLogPanel binds to it.
        const legacy = document.createElement('button');
        legacy.className = 'ldr-small-btn';
        // No data-filter-type — simulating a button that survived a
        // partial migration. The count badge is still inside.
        legacy.innerHTML = 'Errors <span class="ldr-filter-count" data-filter-count="error">0</span>';
        document.querySelector('.ldr-filter-buttons').appendChild(legacy);

        logPanel.initialize(`rid-legacy-${Math.random().toString(36).slice(2)}`);

        legacy.click();

        // 'errors' (plural) is accepted by checkLogVisibility as an
        // alias for 'error' (utils/log-helpers.js). The point is that
        // currentFilter must be exactly the label text — not
        // 'errors 0', which would slip through every case and
        // silently fall through to show-all.
        expect(window._logPanelState.currentFilter).toBe('errors');
        // And filterLogsByType must have applied the visible state
        // change, not silently fall through to show-all.
        expect(legacy.classList.contains('ldr-selected')).toBe(true);
    });
});

describe('queued logs', () => {
    it('queues logs added while collapsed when no toggle handler is bound', () => {
        // No initialize() call → no auto-expand handler, so the synthetic
        // toggle.click() inside addConsoleLog is a no-op and the queue
        // accumulates. This is the path that triggers when logs arrive
        // before the panel finishes initializing.
        const container = document.getElementById('console-log-container');

        logPanel.addLog('queued before init', 'info');

        expect(window._logPanelState.queuedLogs.length).toBe(1);
        expect(container.querySelector('.ldr-console-log-entry')).toBeNull();
    });

    it('drains the queue when the panel is expanded', () => {
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({ json: () => Promise.resolve([]) })
        );
        setupPanelDom({ page: 'progress' });
        // Pre-seed a queued entry, simulating a log that arrived while the
        // panel was still collapsed.
        window._logPanelState.queuedLogs.push({
            id: 'pre-queued-1',
            time: new Date().toISOString(),
            message: 'pre-queued',
            type: 'info',
            metadata: { type: 'info' },
        });
        expect(window._logPanelState.queuedLogs.length).toBe(1);

        document.getElementById('log-panel-toggle').click();

        expect(window._logPanelState.queuedLogs.length).toBe(0);
        const container = document.getElementById('console-log-container');
        expect(container.querySelector('.ldr-console-log-entry')).not.toBeNull();
        expect(window._logPanelState.counts.info).toBe(1);
        expect(document.querySelector('[data-filter-count="info"]').textContent).toBe('1');
    });

    it('bypasses the queue when the panel is already expanded', () => {
        setupPanelDom({ page: 'progress' });
        window._logPanelState.expanded = true;

        logPanel.addLog('direct', 'info');

        expect(window._logPanelState.queuedLogs.length).toBe(0);
        const container = document.getElementById('console-log-container');
        expect(container.querySelector('.ldr-console-log-entry')).not.toBeNull();
    });
});

describe('per-category counters', () => {
    function getFilterCount(key) {
        const el = document.querySelector(
            `.ldr-filter-count[data-filter-count="${key}"]`
        );
        if (!el) return null;
        // textContent is the rendered string ("0", "1", ...).
        const trimmed = el.textContent.trim();
        return trimmed === '' ? 0 : parseInt(trimmed, 10);
    }

    afterEach(() => {
        // Safety net for any test in this block that enables fake
        // timers — ``vi.setSystemTime`` (used to pin
        // ``addLog``'s ``new Date()`` for the duplicate-bypass tests) is
        // itself a fake-timer-only tool, and we want a uniform teardown
        // so a failure mid-test can't leak faked timers into a neighbour.
        // The batch-load test below also mocks fetch — drop that too.
        vi.clearAllTimers();
        vi.useRealTimers();
        delete globalThis.fetch;
    });

    it('increments the matching category count when addLog is called', () => {
        setupPanelDom({ page: 'progress' });
        window._logPanelState.expanded = true;

        // Use distinct messages so the 10-newest content dedup doesn't
        // collapse adjacent inserts of the same text.
        logPanel.addLog('hello info one', 'info');
        logPanel.addLog('hello info two', 'info');
        logPanel.addLog('boom error', 'error');
        logPanel.addLog('milestone!', 'milestone');

        expect(window._logPanelState.counts.info).toBe(2);
        expect(window._logPanelState.counts.error).toBe(1);
        expect(window._logPanelState.counts.milestone).toBe(1);
        expect(window._logPanelState.counts.warning).toBe(0);
    });

    it('groups live Loguru aliases without rewriting their rendered severity', () => {
        setupPanelDom({ page: 'progress', researchId: null });
        window._logPanelState.expanded = true;

        logPanel.addLog('critical-event', 'CRITICAL');
        logPanel.addLog('fatal-event', 'FATAL');
        logPanel.addLog('successful-operation', 'SUCCESS');

        expect(window._logPanelState.counts).toEqual({
            info: 0,
            milestone: 1,
            warning: 0,
            error: 2,
        });
        expect(getFilterCount('error')).toBe(2);
        expect(getFilterCount('milestone')).toBe(1);
        expect(getFilterCount('all')).toBe(3);

        const rows = Array.from(document.querySelectorAll(
            '.ldr-console-log-entry'
        ));
        expect(rows.map((row) => row.dataset.logType)).toEqual([
            'critical',
            'fatal',
            'success',
        ]);
        expect(rows.map((row) => row.querySelector(
            '.ldr-log-badge'
        ).textContent)).toEqual(['CRITICAL', 'FATAL', 'SUCCESS']);
        expect(rows[0].classList.contains('ldr-log-critical')).toBe(true);
        expect(rows[1].classList.contains('ldr-log-fatal')).toBe(true);
        expect(rows[2].classList.contains('ldr-log-success')).toBe(true);
    });

    it('updates the filter button badges after addLog', () => {
        setupPanelDom({ page: 'progress' });
        window._logPanelState.expanded = true;

        logPanel.addLog('a-info', 'info');
        logPanel.addLog('b-warning', 'warning');
        logPanel.addLog('c-warning', 'warning');
        logPanel.addLog('d-error', 'error');

        expect(getFilterCount('info')).toBe(1);
        expect(getFilterCount('warning')).toBe(2);
        expect(getFilterCount('error')).toBe(1);
        expect(getFilterCount('milestone')).toBe(0);
        // 'all' badge is the sum of the per-category counts.
        expect(getFilterCount('all')).toBe(4);
    });

    it('renders a "0" badge for never-touched categories', () => {
        setupPanelDom({ page: 'progress' });
        // No addLog calls. The badges should all read "0" so the user
        // can see at a glance that no entries of that type exist.
        expect(getFilterCount('info')).toBe(0);
        expect(getFilterCount('milestone')).toBe(0);
        expect(getFilterCount('warning')).toBe(0);
        expect(getFilterCount('error')).toBe(0);
        expect(getFilterCount('all')).toBe(0);
    });

    it('does not double-count when a duplicate is deduped', () => {
        setupPanelDom({ page: 'progress' });
        window._logPanelState.expanded = true;

        logPanel.addLog('same-msg', 'info');
        logPanel.addLog('same-msg', 'info');

        // Content dedup collapses the second insert, so the per-category
        // counter must NOT bump.
        expect(window._logPanelState.counts.info).toBe(1);
        expect(getFilterCount('info')).toBe(1);
    });

    // Explicit timeout only — fake timers are no longer required for
    // this test. Earlier revisions faked timers so the per-row
    // ``setTimeout(autoscroll, 0)`` inside ``insertLive`` didn't pile up
    // 501 real-timer tasks; that autoscroll now happens synchronously
    // (``container.scrollTop = 0``, see logpanel.js), so the only
    // remaining budget pressure is honest compute. ``addLog`` still does
    // a full-container querySelectorAll dedup/insert/scan per insert,
    // which is O(n²) DOM work (~2.6-2.9s in happy-dom), so the
    // vitest default 5s leaves no headroom under parallel CI load.
    // Pinning a per-test timeout to 20s is the right lever now that the
    // timer pileup is gone (#4304 was the old root cause).
    it('does NOT decrement the matching category count when the cap prunes an entry', { timeout: 20000 }, () => {
        // Live panels track CUMULATIVE counts (state.cumulativeCounts)
        // so the per-category badges always show "how many errors /
        // warnings / milestones has this research produced since it
        // started?" — not "how many of those are currently on screen?".
        // pruneToCap removes rows from the DOM but does NOT touch
        // cumulativeCounts. The DOM-derived counts (state.counts) do
        // drop, but the badge uses the cumulative copy.
        vi.useFakeTimers();
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([]),
            })
        );
        setupPanelDom({ page: 'progress' });
        window._logPanelState.expanded = true;

        // Fill the DOM up to the cap with distinct info entries.
        const base = new Date('2026-05-08T12:00:00Z').getTime();
        for (let i = 0; i < MAX_LOG_ENTRIES; i++) {
            vi.setSystemTime(new Date(base + i * 1000));
            logPanel.addLog(`info-${i}`, 'info');
        }
        // One more insert triggers the prune path. The head (oldest
        // info-0) is removed from the DOM but the lifetime counts
        // keep growing — the badge stays at MAX_LOG_ENTRIES + 1.
        logPanel.addLog('info-overflow', 'info');

        // The cumulative counters track every insert, even ones the
        // prune later evicts. The DOM-derived state.counts would show
        // MAX_LOG_ENTRIES (one row was pruned) — we don't assert that.
        expect(window._logPanelState.cumulativeCounts.info).toBe(
            MAX_LOG_ENTRIES + 1
        );
        expect(window._logPanelState.cumulativeTotal).toBe(
            MAX_LOG_ENTRIES + 1
        );
        // The user-visible filter badge uses the cumulative count.
        expect(getFilterCount('info')).toBe(MAX_LOG_ENTRIES + 1);
        expect(getFilterCount('all')).toBe(MAX_LOG_ENTRIES + 1);
    });

    it('recomputes counts from the DOM after batch load', async () => {
        // Setup fetch BEFORE setupPanelDom — initialize() inside setupPanelDom
        // triggers its own loadLogs that will race our explicit call otherwise.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () =>
                    Promise.resolve([
                        { timestamp: '2026-05-08T12:00:00Z', message: 'i1', log_type: 'info' },
                        { timestamp: '2026-05-08T12:00:01Z', message: 'i2', log_type: 'info' },
                        { timestamp: '2026-05-08T12:00:02Z', message: 'e1', log_type: 'error' },
                        { timestamp: '2026-05-08T12:00:03Z', message: 'm1', log_type: 'milestone' },
                        { timestamp: '2026-05-08T12:00:04Z', message: 'c1', log_type: 'CRITICAL' },
                        { timestamp: '2026-05-08T12:00:05Z', message: 'f1', log_type: 'FATAL' },
                        { timestamp: '2026-05-08T12:00:06Z', message: 's1', log_type: 'SUCCESS' },
                    ]),
            })
        );

        setupPanelDom({ page: 'progress' });
        window._logPanelState.expanded = true;

        // Drain the loadLogs Promise that setupPanelDom's initialize() call
        // fired internally — we explicitly reload with logs below and the
        // in-flight guard would otherwise dedup against the implicit fetch.
        await logPanel.loadLogs('test-research-batch-counters');

        // Alias severities join the matching display bucket without changing
        // the raw type stored on each rendered row.
        expect(window._logPanelState.counts.info).toBe(2);
        expect(window._logPanelState.counts.error).toBe(3);
        expect(window._logPanelState.counts.milestone).toBe(2);
        expect(window._logPanelState.counts.warning).toBe(0);
        expect(getFilterCount('error')).toBe(3);
        expect(getFilterCount('milestone')).toBe(2);
        expect(getFilterCount('all')).toBe(7);
        expect(Array.from(document.querySelectorAll(
            '.ldr-console-log-entry'
        )).map((entry) => entry.dataset.logType)).toContain('critical');
        expect(Array.from(document.querySelectorAll(
            '.ldr-console-log-entry'
        )).map((entry) => entry.dataset.logType)).toContain('fatal');
        expect(Array.from(document.querySelectorAll(
            '.ldr-console-log-entry'
        )).map((entry) => entry.dataset.logType)).toContain('success');
    });
});

describe('log count indicator — persisted total and Load older', () => {
    function addLogIndicator(researchId) {
        const indicator = document.createElement('span');
        indicator.className = 'ldr-log-indicator';
        indicator.id = 'log-indicator';
        indicator.textContent = '0';
        document.getElementById('log-panel-toggle').appendChild(indicator);
        window._logPanelState.connectedResearchId = researchId;
        return indicator;
    }

    function makeLogs(count) {
        return Array.from({ length: count }, (_, index) => ({
            id: index + 1,
            timestamp: `2026-05-08T12:00:${String(index).padStart(2, '0')}Z`,
            message: `history-${index}`,
            log_type: 'info',
        }));
    }

    function mockLogFetch(totalLogs, initialLogs, expandedLogs = initialLogs) {
        // Re-key the entries so they look like a real cursor-paginated
        // server response. The production logpanel drives Load older /
        // Load newer off the small/large row id in the rendered slice,
        // so a mock whose initial fetch returns ids [1..count] for any
        // totalLogs would behave like a panel pinned to the oldest
        // slice — Load older then wrongly hides because oldestLoadedId
        // is 1. Mirroring the newest-N initial fetch (ids in the range
        // [totalLogs - count + 1 .. totalLogs]) and the matching
        // older-batch ids puts the cursor where the production code
        // expects it after a fresh load, so the button visibility
        // checks exercise the same code path as the live app.
        const rekey = (entries, startId) =>
            entries.map((e, i) => ({
                ...e,
                id: startId + i,
            }));
        const initialRekeyed = rekey(
            initialLogs,
            totalLogs - initialLogs.length + 1,
        );
        const expandedRekeyed = rekey(
            expandedLogs,
            totalLogs - initialLogs.length - expandedLogs.length + 1,
        );
        const fetchSpy = vi.fn((url) => {
            if (url.endsWith('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: totalLogs }),
                });
            }
            const logs = url.includes('?limit=5000')
                ? expandedRekeyed
                : initialRekeyed;
            return Promise.resolve({
                json: () => Promise.resolve(logs),
            });
        });
        globalThis.fetch = fetchSpy;
        return fetchSpy;
    }

    it('shows the range display even when the persisted total is fully rendered', async () => {
        // The new format: "showing A–B out of Y logs". With 2 total and
        // 2 rendered, A = 1, B = 2, Y = 2 — the range tightens to the
        // entire 2-row research.
        const researchId = 'log-count-equal';
        const indicator = addLogIndicator(researchId);
        mockLogFetch(2, makeLogs(2));

        await logPanel.loadLogs(researchId);

        expect(indicator.textContent).toBe(
            'showing 1\u20132 out of 2 logs'
        );
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('shows the persisted total and Load older when the rendered slice is truncated', async () => {
        // 9,002 total, 2 rendered. Under the user's bump-by-window-
        // size math: A = 1 (fresh-load starts at 1), B = 2 (the
        // returned window's size — capped by the response, not the
        // requested limit), Y = 9,002.
        const researchId = 'log-count-truncated';
        const indicator = addLogIndicator(researchId);
        mockLogFetch(9002, makeLogs(2));

        await logPanel.loadLogs(researchId);

        expect(indicator.textContent).toBe(
            'showing 1–2 out of 9,002 logs'
        );
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
    });

    it('does not offer Load older when all rows were fetched but routine duplicates were grouped', async () => {
        const researchId = 'log-count-grouped';
        const indicator = addLogIndicator(researchId);
        const repeatedLogs = [
            { id: 1, timestamp: '2026-05-08T12:00:00Z', message: 'routine debug', log_type: 'debug' },
            { id: 2, timestamp: '2026-05-08T12:00:01Z', message: 'routine debug', log_type: 'debug' },
        ];
        mockLogFetch(2, repeatedLogs);

        await logPanel.loadLogs(researchId);

        // parseLogs collapses the two duplicates into one row with
        // repeatCount=2. The cumulative count reflects both server
        // rows (cumulativeTotal = 2), so the indicator's A position
        // is Y - cumulative + 1 = 1.
        expect(indicator.textContent).toBe(
            'showing 1\u20132 out of 2 logs'
        );
        expect(document.querySelector('.ldr-duplicate-counter').textContent).toBe('(2×)');
        expect(document.querySelector('.ldr-load-older')).toBeNull();
        expect(window._logPanelState.fetchedLogs).toBe(2);
    });

    it('degrades to the rendered count when the persisted total cannot be fetched', async () => {
        const researchId = 'log-count-unavailable';
        const indicator = addLogIndicator(researchId);
        const fetchSpy = vi.fn((url) => {
            if (url.endsWith('/log_count')) {
                return Promise.reject(new Error('count endpoint unavailable'));
            }
            return Promise.resolve({
                json: () => Promise.resolve(makeLogs(2)),
            });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);

        expect(indicator.textContent).toBe('2');
        expect(document.querySelector('.ldr-log-of-total')).toBeNull();
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('handles a missing research count without reporting malformed data', async () => {
        const researchId = 'log-count-missing-research';
        const indicator = addLogIndicator(researchId);
        const countJson = vi.fn();
        const errorSpy = vi.spyOn(SafeLogger, 'error');
        globalThis.fetch = vi.fn((url) => {
            if (url.endsWith('/log_count')) {
                return Promise.resolve({
                    ok: false,
                    status: 404,
                    json: countJson,
                });
            }
            return Promise.resolve({
                ok: false,
                status: 404,
                json: () => Promise.resolve({ status: 'error' }),
            });
        });

        await logPanel.loadLogs(researchId);

        expect(indicator.textContent).toBe('0');
        expect(countJson).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalledWith(
            'Invalid log count data received from API'
        );
        errorSpy.mockRestore();
    });

    it('reloads up to the hard cap and refreshes the badge after Load older', async () => {
        const researchId = 'log-count-load-older';
        const indicator = addLogIndicator(researchId);
        // Use distinct messages for the Load older batch so the
        // twin-key dedup doesn't drop any of them — we want to verify
        // the cumulative count after a fully-merged Load older.
        const initialLogs = makeLogs(2);
        const expandedLogs = makeLogs(4).map((entry, i) => ({
            ...entry,
            message: `expanded-${i}`,
            // Distinct timestamps too — the twin-key check is
            // type+message+timestamp.
            timestamp: `2026-05-08T11:00:${String(i).padStart(2, '0')}Z`,
        }));
        const fetchSpy = mockLogFetch(9002, initialLogs, expandedLogs);

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();

        loadOlder.click();
        await vi.waitFor(() => {
            // The URL now carries before_id=<oldestLoadedId> (1) so the
            // server's before_id cursor is stable under live inserts.
            expect(fetchSpy).toHaveBeenCalledWith(
                expect.stringContaining(
                    `/api/research/${researchId}/logs?limit=5000&before_id=`
                )
            );
            expect(
                window._logPanelState.cumulativeTotal
            ).toBe(6);
        });

        // Live panels show the LIFETIME total (cumulativeTotal = 2
        // from the initial load + 4 from the Load older batch = 6).
        // Under the user's bump-by-window-size math for "showing
        // A\u2013B out of Y logs":
        //   Initial fetch returned 2 rows: A = 1, B = 2, Y = 9,002.
        //   Load older returned 4 more rows: viewOffset += 2 (the
        //   previous viewWindowSize), viewWindowSize = 4. New A = 3,
        //   new B = min(Y, 3 + 4 - 1) = 6.
        expect(indicator.textContent).toBe(
            'showing 3\u20136 out of 9,002 logs'
        );
        // The cap grows to the server's reported total so freshly-loaded
        // rows survive future live inserts without being immediately
        // pruned (this is the old bug that the user reported and the
        // current implementation fixed). With 9002 server rows and 4
        // in the DOM, there are still ~8998 rows the user can page into,
        // so the button must stay visible — it is NOT removed just
        // because renderedLimit has hit 5000.
        expect(window._logPanelState.renderedLimit).toBe(9002);
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
    });

    it('hides the Load older button once every row on the server has been fetched', async () => {
        // The cursor-based contract: the button stays visible as long
        // as the server has more rows than the user has loaded. The
        // button hides when the latest fetch returns the same number
        // of rows as the persisted total (we've paged everything the
        // server has). The indicator's range stays visible (live panels
        // show it unconditionally) but the Load older button goes away.
        const researchId = 'log-count-all-fetched';
        const indicator = addLogIndicator(researchId);
        // 4-row server, initial fetch returns all 4. No Load older.
        mockLogFetch(4, makeLogs(4));

        await logPanel.loadLogs(researchId);

        // After a single fetch that returns every server row, A = 1,
        // B = Y = 4. The DOM holds all 4 rows. No truncation, no Load
        // older button.
        expect(indicator.textContent).toBe(
            'showing 1\u20134 out of 4 logs'
        );
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('hides the Load older button when a Load older batch matches the persisted total', async () => {
        // Companion to the previous test: same contract, exercised via
        // a Load older page-forward that lands the last missing rows.
        // We use a 5-row server so the initial fetch (2 rows) leaves a
        // truncation visible, and the Load older batch (3 distinct
        // rows) fills the gap exactly.
        const researchId = 'log-count-load-older-fills-total';
        const indicator = addLogIndicator(researchId);
        const fetchSpy = mockLogFetch(
            5,
            makeLogs(2),
            Array.from({ length: 3 }, (_, index) => ({
                timestamp: new Date(
                    Date.parse('2026-05-08T12:00:00Z') - (index + 100) * 1000
                ).toISOString(),
                message: `older-${index}`,
                log_type: 'info',
            }))
        );

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();

        loadOlder.click();
        await vi.waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledWith(
                expect.stringContaining(
                    `/api/research/${researchId}/logs?limit=5000&before_id=`
                )
            );
            expect(
                window._logPanelState.cumulativeTotal
            ).toBe(5);
        });

        // We've now paged every server row. Lifetime total is 5 (2 + 3).
        // Under the user's bump-by-window-size math:
        //   Initial viewWindowSize = 2, A = 1, B = 2.
        //   After Load older (fetched 3): viewOffset += 2 (now 2),
        //   viewWindowSize = 3. A = 1 + 2 = 3, B = min(Y, 3 + 3 - 1) = 5.
        // The cursor for the next ``?before_id`` request is now id=1
        // (smallest id in the loaded set), so there's nothing older to
        // fetch — Load older hides.
        expect(indicator.textContent).toBe(
            'showing 3\u20135 out of 5 logs'
        );
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('stops propagation on the Load older click so the panel does not collapse', async () => {
        // The button is appended inside the same header element that
        // owns the collapse/expand toggle (log-panel-toggle). Without
        // event.stopPropagation the click bubbles up and triggers the
        // toggle handler, hiding the expanded log list the user just
        // asked to load. Lock that stopPropagation is wired in.
        const researchId = 'log-count-stop-propagation';
        addLogIndicator(researchId);
        mockLogFetch(9002, makeLogs(2));

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();

        // Spy on stopPropagation. happy-dom's Event dispatches
        // stopPropagation through the normal EventTarget path, so a
        // click on the button should land the call before any bubble
        // listener on the parent runs. The bubble-phase listener
        // (third arg omitted/false) fires AFTER the button handler,
        // so stopPropagation must have run by the time it would
        // execute.
        const stopSpy = vi.spyOn(Event.prototype, 'stopPropagation');
        const toggleEl = document.getElementById('log-panel-toggle');
        const bubbleSpy = vi.fn();
        toggleEl.addEventListener('click', bubbleSpy);

        loadOlder.click();

        expect(stopSpy).toHaveBeenCalled();
        expect(bubbleSpy).not.toHaveBeenCalled();

        stopSpy.mockRestore();
        toggleEl.removeEventListener('click', bubbleSpy);
    });

    it('removes stale Load older / Load newer controls when the research changes', async () => {
        // Initialize for research A and let the indicator paint a
        // "showing A\u2013B out of Y logs" with a Load older button. Then
        // re-init with research B \u2014 the previous research's controls must be
        // torn down so the header doesn't keep showing A's persisted
        // total next to B's content.
        const researchA = 'log-count-research-a';
        addLogIndicator(researchA);
        mockLogFetch(9002, makeLogs(2));

        await logPanel.loadLogs(researchA);
        // Indicator shows A's range before the switch. Under the user's
        // bump-by-window-size math: A = 1 (fresh load starts at 1),
        // B = min(Y, returned size) = min(9002, 2) = 2.
        const indicatorEl = document.getElementById('log-indicator');
        expect(indicatorEl.textContent).toBe(
            'showing 1\u20132 out of 9,002 logs'
        );
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();

        // Re-init for research B.
        const researchB = 'log-count-research-b';
        logPanel.initialize(researchB);

        // All header controls reset immediately after the switch so a
        // pending click on the old button can't fire against B.
        // The indicator degrades back to the bare cumulative count
        // because /log_count hasn't been re-fetched for B yet.
        expect(document.querySelector('.ldr-load-older')).toBeNull();
        expect(window._logPanelState.connectedResearchId).toBe(researchB);
        expect(window._logPanelState.totalLogs).toBeNull();
        expect(window._logPanelState.counts).toEqual(emptyCounts());
        // Generation must have been bumped so any in-flight count
        // response for A is treated as stale.
        expect(typeof window._logPanelState._countRequestGen).toBe('number');
    });

    it('keeps of Y and Load older when initialize is called again for the same research', async () => {
        const researchId = 'log-count-same-research-reinit';
        addLogIndicator(researchId);
        mockLogFetch(9002, makeLogs(2));

        logPanel.initialize(researchId);
        await logPanel.loadLogs(researchId);
        const indicatorEl = document.getElementById('log-indicator');
        // Fresh-load math: A = 1, B = min(Y, returned size) = 2.
        expect(indicatorEl.textContent).toBe(
            'showing 1\u20132 out of 9,002 logs'
        );
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
        const gen = window._logPanelState._countRequestGen;

        logPanel.initialize(researchId);

        // Same research re-init preserves everything: the indicator
        // text, the Load older button, and the count generation so
        // any in-flight count response is still considered current.
        expect(indicatorEl.textContent).toBe(
            'showing 1\u20132 out of 9,002 logs'
        );
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
        expect(window._logPanelState._countRequestGen).toBe(gen);
        expect(window._logPanelState.totalLogs).toBe(9002);
    });

    it('discards a stale count response from the previous research', async () => {
        // Research A's fetch resolves AFTER the user has switched to
        // research B. The response must NOT overwrite B's badge with
        // A's total — the generation guard should drop it.
        const researchA = 'log-count-stale-a';
        const researchB = 'log-count-stale-b';

        // Build a fetch spy where the count response for A is delayed
        // so we can switch to B while it's in flight.
        let resolveCount;
        const countPromise = new Promise((resolve) => {
            resolveCount = resolve;
        });
        const fetchSpy = vi.fn((url) => {
            if (url.endsWith('/log_count') && url.includes(researchA)) {
                return Promise.resolve({
                    json: () => countPromise,
                });
            }
            if (url.endsWith('/logs')) {
                return Promise.resolve({
                    json: () => Promise.resolve(makeLogs(2)),
                });
            }
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: 100 }),
            });
        });
        globalThis.fetch = fetchSpy;

        addLogIndicator(researchA);
        const loadA = logPanel.loadLogs(researchA);
        // Yield so the count fetch for A has been initiated but not
        // yet resolved (it's gated on our manual resolveCount).
        await Promise.resolve();
        await Promise.resolve();

        // Switch to B before A's count resolves.
        logPanel.initialize(researchB);

        // Now resolve A's count late. The guard should treat it as
        // stale and NOT write totalLogs.
        resolveCount({ total_logs: 9002 });
        await loadA;

        // totalLogs should be null (B hasn't fetched its own count
        // yet, and A's was discarded). B's subsequent loadLogs call
        // would set it; here we only verify the stale write was
        // skipped.
        expect(window._logPanelState.totalLogs).toBeNull();
    });

    it('discards stale log responses and DOM commits when switching research while /logs is in flight (success case)', async () => {
        // Research A's fetch resolves AFTER the user has switched to
        // research B. The response must NOT write to the DOM or mark
        // as loaded.
        const researchA = 'log-stale-logs-a';
        const researchB = 'log-stale-logs-b';

        // Build a fetch spy where the logs response for A is delayed
        // so we can switch to B while it's in flight.
        let logsFetchStartedA;
        const fetchStartedPromiseA = new Promise((resolve) => {
            logsFetchStartedA = resolve;
        });

        let resolveLogsA;
        const logsAPromise = new Promise((resolve) => {
            resolveLogsA = resolve;
        });

        const fetchSpy = vi.fn((url) => {
            if (url.includes('/logs') && url.includes(researchA)) {
                logsFetchStartedA();
                return Promise.resolve({
                    json: () => logsAPromise,
                });
            }
            if (url.includes('/logs') && url.includes(researchB)) {
                return Promise.resolve({
                    json: () => Promise.resolve([
                        { timestamp: new Date().toISOString(), message: 'B logs', log_type: 'info' }
                    ]),
                });
            }
            // For count and other requests
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: 100 }),
            });
        });
        globalThis.fetch = fetchSpy;

        // Initialize for A without background pre-fetch.
        setupPanelDom({ researchId: null });
        logPanel.initialize(null);
        window._logPanelState.connectedResearchId = researchA;

        // Trigger loadLogs for A (test owns this request).
        const loadA = logPanel.loadLogs(researchA);

        // Wait until A's /logs request begins.
        await fetchStartedPromiseA;

        // Switch to B before A's logs fetch resolves.
        // B's initialize will clear the container and reset dataset.loaded.
        logPanel.initialize(researchB);
        const loadB = logPanel.loadLogs(researchB);
        await loadB;

        const container = document.getElementById('console-log-container');
        const panelContent = document.getElementById('log-panel-content');

        // B should be successfully loaded and contain its logs
        let texts = Array.from(container.querySelectorAll('.ldr-log-message')).map(el => el.textContent);
        expect(texts).toContain('B logs');
        expect(panelContent.dataset.loaded).toBe('true');
        expect(panelContent.dataset.loading).toBeUndefined();

        // Resolve A's logs late.
        resolveLogsA([
            { timestamp: new Date().toISOString(), message: 'A logs', log_type: 'info' }
        ]);
        await loadA;

        // Verify A's logs did NOT render into B's container.
        texts = Array.from(container.querySelectorAll('.ldr-log-message')).map(el => el.textContent);
        expect(texts).not.toContain('A logs');
        expect(texts).toContain('B logs');
        expect(panelContent.dataset.loaded).toBe('true');
        expect(panelContent.dataset.loading).toBeUndefined();
    });

    it('discards stale log responses and DOM commits when switching research while /logs is in flight (failure/rejection case)', async () => {
        // Research A's fetch rejects AFTER the user has switched to
        // research B. The error response must NOT overwrite B's DOM,
        // clear loaded status, or leave B's container in an error state.
        const researchA = 'log-stale-logs-fail-a';
        const researchB = 'log-stale-logs-fail-b';

        let logsFetchStartedA;
        const fetchStartedPromiseA = new Promise((resolve) => {
            logsFetchStartedA = resolve;
        });

        let rejectLogsA;
        const logsAPromise = new Promise((resolve, reject) => {
            rejectLogsA = reject;
        });
        logsAPromise.catch(() => {});

        const fetchSpy = vi.fn((url) => {
            if (url.includes('/logs') && url.includes(researchA)) {
                logsFetchStartedA();
                return Promise.resolve({
                    json: () => logsAPromise,
                });
            }
            if (url.includes('/logs') && url.includes(researchB)) {
                return Promise.resolve({
                    json: () => Promise.resolve([
                        { timestamp: new Date().toISOString(), message: 'B logs', log_type: 'info' }
                    ]),
                });
            }
            // For count and other requests
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: 100 }),
            });
        });
        globalThis.fetch = fetchSpy;

        // Initialize for A without background pre-fetch.
        setupPanelDom({ researchId: null });
        logPanel.initialize(null);
        window._logPanelState.connectedResearchId = researchA;

        // Trigger loadLogs for A (test owns this request).
        const loadA = logPanel.loadLogs(researchA);

        // Wait until A's /logs request begins.
        await fetchStartedPromiseA;

        // Switch to B before A's logs fetch rejects.
        logPanel.initialize(researchB);
        const loadB = logPanel.loadLogs(researchB);
        await loadB;

        const container = document.getElementById('console-log-container');
        const panelContent = document.getElementById('log-panel-content');

        // B should be successfully loaded and contain its logs
        let texts = Array.from(container.querySelectorAll('.ldr-log-message')).map(el => el.textContent);
        expect(texts).toContain('B logs');
        expect(panelContent.dataset.loaded).toBe('true');
        expect(panelContent.dataset.loading).toBeUndefined();

        // Reject A's logs fetch late.
        rejectLogsA(new Error('A logs fetch failed'));
        await loadA;

        // Verify B's DOM, loaded marker, and loading state remain untouched.
        texts = Array.from(container.querySelectorAll('.ldr-log-message')).map(el => el.textContent);
        expect(texts).not.toContain('A logs fetch failed');
        expect(container.querySelector('.ldr-error-message')).toBeNull();
        expect(texts).toContain('B logs');
        expect(panelContent.dataset.loaded).toBe('true');
        expect(panelContent.dataset.loading).toBeUndefined();
    });

    it('does not corrupt the All filter badge when the lifetime total exceeds 1,000 and uses comma formatting', async () => {
        // Regression test for the historical blocker: renderHeader writes
        // a comma-grouped label like "9,002" to .ldr-log-indicator, and
        // the per-category filter badge update must not truncate that to
        // "9" when summing the All bucket. Live panels now use
        // cumulativeTotal for the indicator and the All badge — so we
        // seed a cumulativeTotal of 9,002 and call renderHeader directly
        // to confirm both the header indicator and the All badge agree
        // on "9,002" / "9002".
        setupPanelDom({ researchId: null });

        const researchId = 'log-count-large-run';
        const indicator = addLogIndicator(researchId);

        // Seed the lifetime total. We don't need to actually have 9,002
        // DOM rows — just the counter value and the renderHeader path
        // that writes the comma-formatted text into both the indicator
        // and the All badge.
        window._logPanelState.cumulativeTotal = 9002;
        window._logPanelState.expanded = true;
        // Use addLog to trigger renderHeader (which is the path under
        // test). The addLog itself bumps cumulativeTotal to 9,003.
        logPanel.addLog('trigger-indicator-refresh', 'info');

        // After the addLog, the lifetime total is 9,003. The
        // indicator under the new format degrades to the bare
        // cumulative count when /log_count has never landed (this
        // test seeds cumulativeTotal without a real log_count fetch).
        // The All badge agrees on the same comma-formatted value.
        const indicatorText = indicator.textContent;
        expect(indicatorText).toBe('9,003');
        const allBadge = document.querySelector('.ldr-filter-count[data-filter-count="all"]');
        expect(allBadge.textContent).toBe('9003');
    });

    it('preserves the indicator and Load older control in transient states when fetchedLogs is null', async () => {
        setupPanelDom({ researchId: null });

        const researchId = 'log-count-transient-null';
        const indicator = addLogIndicator(researchId);
        mockLogFetch(9002, makeLogs(2));

        await logPanel.loadLogs(researchId);

        // Before transient state: indicator shows the range and the
        // Load older button is visible. Fresh-load math: A = 1, B = 2.
        expect(indicator.textContent).toBe(
            'showing 1\u20132 out of 9,002 logs'
        );
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();

        // Simulate transient state: fetchedLogs is set to null.
        // Force expanded so addLog commits via insertLive (the
        // collapsed-panel path queues the log instead of inserting).
        window._logPanelState.fetchedLogs = null;
        window._logPanelState.expanded = true;
        const cumulativeBeforeAddLog = window._logPanelState.cumulativeTotal;
        logPanel.addLog('transient-socket-log', 'info');
        const cumulativeAfterAddLog = window._logPanelState.cumulativeTotal;
        // Sanity: addLog must increment cumulative so the A side of
        // the range tightens.
        expect(cumulativeAfterAddLog).toBe(cumulativeBeforeAddLog + 1);

        // The controls should still be visible because totalLogs (9002) > rendered (3).
        // Under the user's bump-by-window-size math, addLog does NOT change
        // viewOffset / viewWindowSize (the socket path is independent of
        // the paginated-batch display state). A and B stay at their
        // initial-load values; only ``Y`` continues to track the server's
        // persisted total when /log_count lands.
        expect(indicator.textContent).toBe(
            'showing 1\u20132 out of 9,002 logs'
        );
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
    });
});

describe('loadLogsForResearch — counter drift when live entries already exist', () => {
    // Regression test for the "/results/<id> shows Info -1" symptom.
    //
    // Repro: socket events populated live entries while the persisted
    // logCount fetch was in flight. loadLogsForResearch then fires and
    // sees `hasLiveEntries=true`, so it processes sortedLogs through
    // `addLogEntryToPanel(logEntry, false)` in a tight loop. Each
    // insert with sortedLogs.length over the cap fires prune decrements
    // (`updateLogCounter(-removed.length)`, `counts[prunedType]--`)
    // with no compensating increment, so the per-category counters
    // and the header indicator drift below zero even though the DOM
    // ends up back at the cap.
    //
    // The first test locks in the structural fix (recompute from the
    // DOM in loadLogsForResearch before exiting the merge path). The
    // second pins updateFilterCounters' defensive Math.max(0, ...) floor
    // while verifying that updateLogCounter keeps the indicator and All
    // badge DOM-derived, so a future refactor cannot surface "Info -1".
    //
    // setupPanelDom() is intentionally NOT used here: it calls
    // logPanel.initialize(rid), which auto-fires a pre-fetch and
    // would race with the deterministic seed below. The DOM is built
    // inline so we own every piece of state the test drives.

    function getFilterCount(key) {
        const el = document.querySelector(
            `.ldr-filter-count[data-filter-count="${key}"]`
        );
        if (!el) return null;
        const trimmed = el.textContent.trim();
        return trimmed === '' ? 0 : parseInt(trimmed, 10);
    }

    function getIndicatorCount() {
        const els = document.querySelectorAll('.ldr-log-indicator');
        if (els.length === 0) return null;
        const trimmed = els[0].textContent.trim();
        return trimmed === '' ? 0 : parseInt(trimmed, 10);
    }

    function buildPanelDom() {
        // Equivalent layout to log_panel.html: container +
        // per-category filter badges + a header indicator. The badge
        // and indicator spans are what updateFilterCounters and
        // updateLogCounter write into; without them the test passes
        // vacuously.
        document.body.innerHTML = `
            <div id="log-panel-content">
                <div id="console-log-container"></div>
            </div>
            <div class="ldr-filter-buttons">
                <span class="ldr-filter-count" data-filter-count="all">0</span>
                <span class="ldr-filter-count" data-filter-count="info">0</span>
                <span class="ldr-filter-count" data-filter-count="milestone">0</span>
                <span class="ldr-filter-count" data-filter-count="warning">0</span>
                <span class="ldr-filter-count" data-filter-count="error">0</span>
            </div>
            <span class="ldr-log-indicator" id="log-indicator">0</span>
            <template id="console-log-entry-template">
                <div class="ldr-console-log-entry">
                    <span class="ldr-log-timestamp"></span>
                    <span class="ldr-log-badge"></span>
                    <span class="ldr-log-message"></span>
                </div>
            </template>
        `;
    }

    it('uses cumulative counts for the live-panel badges (no DOM recompute)', async () => {
        // Live panels show the LIFETIME total via cumulativeCounts /
        // cumulativeTotal, NOT the DOM-derived count. The previous
        // "recomputes from DOM" behavior would have dropped the badge
        // back down as pruneToCap evicted old entries — this test
        // pins the new contract: the badge keeps growing even after
        // the DOM is at the cap.
        //
        // Seed the DOM directly with MAX_LOG_ENTRIES info entries
        // (without going through insertLive, so cumulativeTotal stays
        // at 0). Then load one more entry — cumulativeTotal becomes 1
        // and the badge shows 1, not MAX_LOG_ENTRIES + 1.
        buildPanelDom();
        const container = document.getElementById('console-log-container');
        for (let i = 0; i < MAX_LOG_ENTRIES; i++) {
            container.appendChild(makeLiveEntry(`seed-${i}`, 'info'));
        }
        window._logPanelState.counts = emptyCounts();
        window._logPanelState.counts.info = MAX_LOG_ENTRIES;
        document.getElementById('log-indicator').textContent =
            String(MAX_LOG_ENTRIES);

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve({
                    logs: [{
                        timestamp: '2026-06-09T08:00:00Z',
                        message: 'distinct-batch-entry',
                        log_type: 'info',
                    }],
                }),
            })
        );

        await logPanel.loadLogs('test-research-counter-drift');

        // DOM has MAX_LOG_ENTRIES entries (the new one replaced the
        // oldest via pruneToCap). But cumulativeTotal is 1 — only the
        // newly-inserted entry went through bumpCumulative. The badge
        // reflects the lifetime total, not the DOM count.
        const domEntries = container.querySelectorAll('.ldr-console-log-entry');
        expect(domEntries.length).toBe(MAX_LOG_ENTRIES);
        expect(getIndicatorCount()).toBe(1);
        expect(getFilterCount('all')).toBe(1);
        expect(getFilterCount('info')).toBe(1);
    });

    it('clamps negative category badges while indicator and All follow the rendered DOM', () => {
        // The DOM is the source of truth for counts: renderHeader walks
        // the rendered entries and rebuilds state.counts from scratch,
        // dropping stale negative values that the previous incremental
        // bookkeeping accumulated. This test pins that contract — a
        // single addLog on a panel with stale negative counts must surface
        // positive counts that reflect only the rendered entries, never
        // the negative staleness.
        buildPanelDom();
        window._logPanelState.counts = emptyCounts();
        window._logPanelState.counts.info = -50;
        window._logPanelState.counts.warning = -10;
        window._logPanelState.expanded = true;
        // Stale indicator text is the one piece of pre-seeded DOM the
        // code path can read back: renderHeader derives the indicator and
        // All badge from the DOM after recomputing, so the insert must
        // refresh those values before any other path can read them.
        document.getElementById('log-indicator').textContent = '-60';

        logPanel.addLog('trigger-render', 'info');

        expect(
            document.querySelectorAll('.ldr-console-log-entry')
        ).toHaveLength(1);
        // Counts and badges are recomputed from the DOM, not bumped
        // incrementally — state.counts.info is the real count of the one
        // rendered info row, and the warning bucket (no entries) zeroes
        // out too. There is no negative staleness carried over.
        expect(window._logPanelState.counts.info).toBe(1);
        expect(window._logPanelState.counts.warning).toBe(0);
        expect(document.getElementById('log-indicator').textContent).toBe('1');
        expect(
            document.querySelector('[data-filter-count="all"]').textContent
        ).toBe('1');
        expect(
            document.querySelector('[data-filter-count="info"]').textContent
        ).toBe('1');
        expect(
            document.querySelector('[data-filter-count="warning"]').textContent
        ).toBe('0');
    });

    it('recovers through the exact zero boundary as inserts land on a negative counter', () => {
        // Companion to the clamp test above, covering the boundary where
        // the structural recompute lands the new count at 1 (the rendered
        // row) regardless of the negative staleness, then proves the
        // second insert continues to track the true DOM count.
        buildPanelDom();
        window._logPanelState.counts = emptyCounts();
        window._logPanelState.counts.info = -1;
        window._logPanelState.expanded = true;

        logPanel.addLog('first render', 'info');
        expect(window._logPanelState.counts.info).toBe(1);
        expect(
            document.querySelector('[data-filter-count="info"]').textContent
        ).toBe('1');

        logPanel.addLog('second render', 'info');
        expect(window._logPanelState.counts.info).toBe(2);
        expect(
            document.querySelector('[data-filter-count="info"]').textContent
        ).toBe('2');
    });

    it('counts untracked categories (e.g. DEBUG) toward the header indicator and All badge after a bulk load', async () => {
        // Regression test for the "All badge stays at 0 for a single
        // DEBUG row" symptom found at PR #5128 head.
        //
        // DEBUG is valid persisted API output — it renders in the DOM
        // via the standard bulk-load path but has no corresponding
        // entry in emptyCounts() (info / milestone / warning / error).
        // The previous recomputeCountersFromDom() guarded the per-
        // category bucket increment behind `counts[t] !== undefined`
        // AND bundled the total bump into the same branch, so DEBUG
        // entries contributed nothing to either the header indicator
        // or the All badge. updateFilterCounters() then summed the
        // four tracked buckets for the All badge, which only made it
        // worse. The fix is: total counts every rendered entry; the
        // per-category increment stays conditional so DEBUG doesn't
        // pollute the per-filter badges.
        buildPanelDom();

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve({
                    logs: [{
                        timestamp: '2026-07-01T00:00:00Z',
                        message: 'debug-probe-row',
                        log_type: 'debug',
                    }],
                }),
            })
        );

        await logPanel.loadLogs('test-research-debug-counter');

        const container = document.getElementById('console-log-container');
        const renderedRows = container.querySelectorAll('.ldr-console-log-entry');

        // Exactly one row must be rendered for the probe payload.
        expect(renderedRows.length).toBe(1);
        expect(renderedRows[0].dataset.logType).toBe('debug');

        // The header indicator and All badge must reflect that one
        // rendered row — DEBUG is a rendered log, even though it has
        // no per-filter button. The four tracked buckets stay at zero
        // because the row isn't in any of them.
        expect(getIndicatorCount()).toBe(1);
        expect(getFilterCount('all')).toBe(1);
        expect(getFilterCount('info')).toBe(0);
        expect(getFilterCount('milestone')).toBe(0);
        expect(getFilterCount('warning')).toBe(0);
        expect(getFilterCount('error')).toBe(0);
    });
});

// Regression tests for #5190: a bulk-merge re-fetch (e.g. "Load older")
// must not double-count an already-rendered row.
describe('loadLogsForResearch — bulk-merge re-fetch of an already-rendered row (#5190)', () => {
    beforeEach(() => {
        window._logPanelState.expanded = true;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        delete globalThis.fetch;
    });

    it('does not bump the counter when the ID-based dedup branch matches', async () => {
        const container = document.getElementById('console-log-container');

        const now = new Date('2026-07-20T09:00:00Z');
        vi.setSystemTime(now);
        logPanel.addLog('milestone reached', 'milestone');

        // Same timestamp + message as the live entry above, so the fetched
        // row derives the identical id and hits the ID-based dedup branch.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([{
                    timestamp: now.toISOString(),
                    message: 'milestone reached',
                    log_type: 'milestone',
                }]),
            })
        );

        await logPanel.loadLogs('test-research-5190-id-based');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(1);
        expect(entries[0].dataset.counter).toBe('1');
        expect(entries[0].querySelector('.ldr-duplicate-counter')).toBeNull();
    });

    it('does not duplicate a live milestone when /logs returns the same row under a numeric server id', async () => {
        const container = document.getElementById('console-log-container');
        const now = new Date('2026-07-20T09:00:00Z');
        vi.setSystemTime(now);
        logPanel.addLog('milestone reached', 'milestone');

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([{
                    id: 42,
                    timestamp: now.toISOString(),
                    message: 'milestone reached',
                    log_type: 'milestone',
                }]),
            })
        );

        await logPanel.loadLogs('test-research-5190-numeric-id');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(1);
        expect(entries[0].dataset.counter).toBe('1');
        expect(window._logPanelState.renderedIds.has('42')).toBe(true);
    });

    it('does not duplicate a live error when /logs returns the same row under a numeric server id', async () => {
        const container = document.getElementById('console-log-container');
        const now = new Date('2026-07-20T09:00:00Z');
        vi.setSystemTime(now);
        logPanel.addLog('lookup failed', 'error', { time: now.toISOString() });

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([{
                    id: 77,
                    timestamp: now.toISOString(),
                    message: 'lookup failed',
                    log_type: 'error',
                }]),
            })
        );

        await logPanel.loadLogs('test-research-5190-numeric-id-error');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(1);
        expect(entries[0].dataset.logType).toBe('error');
        expect(window._logPanelState.renderedIds.has('77')).toBe(true);
    });

    it('collapses a /logs replay at the 500ms twin window and inserts at 501ms', async () => {
        const container = document.getElementById('console-log-container');
        const now = new Date('2026-07-20T09:00:00.000Z');
        vi.setSystemTime(now);
        logPanel.addLog('retry-failed', 'warning', { time: now.toISOString() });

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([{
                    id: 88,
                    timestamp: '2026-07-20T09:00:00.500Z',
                    message: 'retry-failed',
                    log_type: 'warning',
                }]),
            })
        );
        await logPanel.loadLogs('test-research-5190-twin-500');
        expect(container.querySelectorAll('.ldr-console-log-entry').length).toBe(1);
        expect(window._logPanelState.renderedIds.has('88')).toBe(true);

        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([{
                    id: 89,
                    timestamp: '2026-07-20T09:00:00.501Z',
                    message: 'retry-failed',
                    log_type: 'warning',
                }]),
            })
        );
        await logPanel.loadLogs('test-research-5190-twin-501');
        expect(container.querySelectorAll('.ldr-console-log-entry').length).toBe(2);
    });

    it('does not bump the counter when the message-based dedup branch matches', async () => {
        const container = document.getElementById('console-log-container');

        vi.setSystemTime(new Date('2026-07-20T09:00:00Z'));
        logPanel.addLog('heartbeat check', 'info');

        // A different timestamp derives a different id, so this row misses
        // the ID-based branch and falls to the content-based scan instead.
        globalThis.fetch = vi.fn(() =>
            Promise.resolve({
                json: () => Promise.resolve([{
                    timestamp: '2026-07-20T09:00:05Z',
                    message: 'heartbeat check',
                    log_type: 'info',
                }]),
            })
        );

        await logPanel.loadLogs('test-research-5190-message-based');

        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(1);
        expect(entries[0].dataset.counter).toBe('1');
        expect(entries[0].querySelector('.ldr-duplicate-counter')).toBeNull();
    });
});

describe('pruneToCap — per-category ordered prune', () => {
    function seedEntry(container, message, type, index) {
        const entry = makeLiveEntry(message, type);
        // logpanel.js sorts by dataset.logTimeMs for chronological ordering.
        // We use a synthetic timestamp so insertion order matches DOM order.
        entry.dataset.logTimeMs = String(index);
        container.appendChild(entry);
        return entry;
    }

    it('drops info entries before any other category', () => {
        const container = document.getElementById('console-log-container');
        // 3 info + 1 warning + 1 error; cap=2.
        seedEntry(container, 'info-0', 'info', 0);
        seedEntry(container, 'info-1', 'info', 1);
        seedEntry(container, 'info-2', 'info', 2);
        seedEntry(container, 'warn-0', 'warning', 3);
        seedEntry(container, 'err-0', 'error', 4);

        const removed = logPanel._pruneToCap(container, 2);

        // 3 removals needed (5 -> 2). All should be info entries.
        expect(removed.length).toBe(3);
        for (const r of removed) expect(r).toBe('info');
        expect(container.children.length).toBe(2);
        // The warning and error must survive.
        const survivingTypes = Array.from(container.children).map(
            (c) => c.dataset.logType
        );
        expect(survivingTypes).toEqual(['warning', 'error']);
    });

    it('drops milestone entries after info is exhausted', () => {
        const container = document.getElementById('console-log-container');
        seedEntry(container, 'info-0', 'info', 0);
        seedEntry(container, 'info-1', 'info', 1);
        seedEntry(container, 'milestone-0', 'milestone', 2);
        seedEntry(container, 'warn-0', 'warning', 3);
        seedEntry(container, 'err-0', 'error', 4);

        // cap=2 -> need 3 removals. 2 info first, then the milestone.
        const removed = logPanel._pruneToCap(container, 2);

        expect(removed).toEqual(['info', 'info', 'milestone']);
        expect(container.children.length).toBe(2);
        const surviving = Array.from(container.children).map(
            (c) => c.dataset.logType
        );
        expect(surviving).toEqual(['warning', 'error']);
    });

    it('preserves old warnings and errors even when the cap is blown by a flood of info', () => {
        const container = document.getElementById('console-log-container');
        // 1 early error, 1 early warning, then 1000 info entries.
        seedEntry(container, 'early-error', 'error', 0);
        seedEntry(container, 'early-warning', 'warning', 1);
        for (let i = 0; i < 1000; i++) {
            seedEntry(container, `info-${i}`, 'info', 2 + i);
        }

        // cap=200. We need to drop 1002 - 200 = 802 entries. The two
        // diagnostic entries are the oldest, but the ordered prune must
        // protect them: all 802 drops must be info entries.
        const querySpy = vi.spyOn(container, 'querySelectorAll');
        const removed = logPanel._pruneToCap(container, 200);

        expect(removed.length).toBe(802);
        expect(removed.every((r) => r === 'info')).toBe(true);
        // The pruning implementation must query once, rather than re-querying
        // and scanning the shrinking DOM for every one of the 802 removals.
        expect(querySpy).toHaveBeenCalledTimes(1);
        querySpy.mockRestore();
        expect(container.children.length).toBe(200);
        const survivingMessages = Array.from(
            container.querySelectorAll('.ldr-log-message')
        ).map((el) => el.textContent);
        expect(survivingMessages).toContain('early-error');
        expect(survivingMessages).toContain('early-warning');
    });

    it('falls back to dropping warnings then errors when no info/milestone are left', () => {
        const container = document.getElementById('console-log-container');
        seedEntry(container, 'warn-0', 'warning', 0);
        seedEntry(container, 'warn-1', 'warning', 1);
        seedEntry(container, 'err-0', 'error', 2);

        // cap=1 -> need 2 removals. No info/milestone, so fall back to
        // dropping the oldest warning first, then the next oldest
        // warning, before touching the error. Errors are the most
        // diagnostic category, so they're the last to be dropped.
        const removed = logPanel._pruneToCap(container, 1);

        expect(removed).toEqual(['warning', 'warning']);
        expect(container.children.length).toBe(1);
        expect(container.firstElementChild.dataset.logType).toBe('error');
        expect(
            container.firstElementChild.querySelector('.ldr-log-message')
                .textContent
        ).toBe('err-0');
    });

    it('is a no-op when already under the cap', () => {
        const container = document.getElementById('console-log-container');
        seedEntry(container, 'info-0', 'info', 0);
        seedEntry(container, 'err-0', 'error', 1);

        const removed = logPanel._pruneToCap(container, 10);

        expect(removed).toEqual([]);
        expect(container.children.length).toBe(2);
    });


    it('ignores placeholder children (.ldr-empty-log-message / spinner / error) when pruning', () => {
        const container = document.getElementById('console-log-container');
        // Simulate the loadLogsForResearch moment where a transient
        // spinner is still in the container alongside incoming entries.
        const spinner = document.createElement('div');
        spinner.className = 'ldr-loading-spinner';
        spinner.textContent = 'Loading...';
        container.appendChild(spinner);

        // Seed one of every category so each priority bucket is exercised.
        seedEntry(container, 'info-A', 'info', 0);
        seedEntry(container, 'milestone-A', 'milestone', 1);
        seedEntry(container, 'warn-A', 'warning', 2);
        seedEntry(container, 'err-A', 'error', 3);

        // Cap of 2 means 2 of the 4 log entries must be dropped.
        // The helper must walk the priority order (info, milestone,
        // warning, error) AND must NOT count or remove the placeholder.
        // If it had counted the spinner, only one entry would be
        // dropped and the test would fail on .removed.length.
        const removed = logPanel._pruneToCap(container, 2);

        expect(removed).toEqual(['info', 'milestone']);
        // Placeholder is left in place; entry nodes are kept too.
        expect(container.querySelector('.ldr-loading-spinner')).toBe(spinner);
        const survivingLogEntries =
            container.querySelectorAll('.ldr-console-log-entry');
        expect(survivingLogEntries.length).toBe(2);
        expect(survivingLogEntries[0].dataset.logType).toBe('warning');
        expect(survivingLogEntries[1].dataset.logType).toBe('error');
        // Total DOM children = surviving 2 entries + 1 placeholder.
        expect(container.children.length).toBe(3);
        expect(container.children[0]).toBe(spinner);
    });

    it('accounts for nested log rows detached with a pruned ancestor', () => {
        const container = document.getElementById('console-log-container');
        const outerInfo = seedEntry(container, 'outer-info', 'info', 0);
        const nestedWarning = seedEntry(
            container,
            'nested-warning',
            'warning',
            1
        );
        const siblingInfo = seedEntry(
            container,
            'sibling-info-survivor',
            'info',
            2
        );
        const milestone = seedEntry(
            container,
            'milestone-survivor',
            'milestone',
            3
        );
        const error = seedEntry(container, 'error-survivor', 'error', 4);
        outerInfo.appendChild(nestedWarning);

        const querySpy = vi.spyOn(container, 'querySelectorAll');
        // Five queried rows at cap=4 means the quota is one, but removing
        // outerInfo atomically detaches its nested warning too. The resulting
        // negative quota must stop both loops before siblingInfo or a later
        // priority tier is touched.
        const removed = logPanel._pruneToCap(container, 4);

        expect(removed).toEqual(['info', 'warning']);
        expect(querySpy).toHaveBeenCalledTimes(1);
        querySpy.mockRestore();
        expect(
            Array.from(
                container.querySelectorAll('.ldr-console-log-entry')
            )
        ).toEqual([siblingInfo, milestone, error]);
    });

    it('drops every entry when cap=0', () => {
        const container = document.getElementById('console-log-container');
        seedEntry(container, 'info-0', 'info', 0);
        seedEntry(container, 'warn-0', 'warning', 1);
        seedEntry(container, 'err-0', 'error', 2);

        expect(logPanel._pruneToCap(container, 0)).toEqual([
            'info',
            'warning',
            'error',
        ]);
        expect(container.querySelectorAll('.ldr-console-log-entry')).toHaveLength(0);
    });

    it("handles a missing dataset.logType using the panel's info fallback", () => {
        const container = document.getElementById('console-log-container');
        const untyped = seedEntry(container, 'untyped', 'info', 0);
        delete untyped.dataset.logType;
        seedEntry(container, 'warn-0', 'warning', 1);
        seedEntry(container, 'err-0', 'error', 2);

        const removed = logPanel._pruneToCap(container, 2);

        expect(removed).toEqual(['info']);
        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['warning', 'error']);
    });

    it('returns an unknown row real type instead of its info priority tier', () => {
        const container = document.getElementById('console-log-container');
        seedEntry(container, 'notice-0', 'NOTICE', 0);
        seedEntry(container, 'warn-0', 'warning', 1);
        seedEntry(container, 'err-0', 'error', 2);

        expect(logPanel._pruneToCap(container, 2)).toEqual(['notice']);
        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['warning', 'error']);
    });

    it('normalizes Loguru severities into explicit pruning tiers', () => {
        const container = document.getElementById('console-log-container');
        seedEntry(container, 'critical-0', 'CRITICAL', 0);
        seedEntry(container, 'trace-0', 'TRACE', 1);
        seedEntry(container, 'success-0', 'SUCCESS', 2);
        seedEntry(container, 'warn-0', 'WARNING', 3);
        seedEntry(container, 'fatal-0', 'FATAL', 4);
        seedEntry(container, 'debug-0', 'DEBUG', 5);
        seedEntry(container, 'milestone-0', 'milestone', 6);
        seedEntry(container, 'info-0', 'INFO', 7);
        seedEntry(container, 'error-0', 'ERROR', 8);

        // TRACE/DEBUG/INFO go first, SUCCESS deliberately shares milestone's
        // tier, then WARNING. CRITICAL/FATAL/ERROR are the three survivors.
        expect(logPanel._pruneToCap(container, 3)).toEqual([
            'trace',
            'debug',
            'info',
            'success',
            'milestone',
            'warning',
        ]);
        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['CRITICAL', 'FATAL', 'ERROR']);
    });
});

describe('downloadLogs — HEAD pre-flight', () => {
    const researchId = 'download-rid';
    const exportUrl = `/api/research/${researchId}/logs/export`;

    beforeEach(() => {
        window.ui = { showAlert: vi.fn() };
        setupPanelDom({ page: 'progress', researchId });
    });

    afterEach(() => {
        delete window.ui;
        vi.restoreAllMocks();
    });

    it.each([
        [404, 'Research logs not found.'],
        [429, 'Log export rate limit exceeded. Please wait a moment.'],
        [500, 'Failed to export logs (HTTP 500).'],
    ])(
        'shows an error and skips the download for HTTP %i',
        async (status, message) => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status,
            });
            const anchorClick = vi
                .spyOn(window.HTMLAnchorElement.prototype, 'click')
                .mockImplementation(() => {});

            document.getElementById('log-download-button').click();

            await vi.waitFor(() => {
                expect(window.ui.showAlert).toHaveBeenCalledWith(
                    message,
                    'error'
                );
            });
            expect(globalThis.fetch).toHaveBeenCalledWith(exportUrl, {
                method: 'HEAD',
            });
            expect(anchorClick).not.toHaveBeenCalled();
        }
    );

    it('starts the native download after a successful pre-flight', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
        });
        let clickedAnchor = null;
        const anchorClick = vi
            .spyOn(window.HTMLAnchorElement.prototype, 'click')
            .mockImplementation(function () {
                clickedAnchor = this;
                expect(document.body.contains(this)).toBe(true);
            });
        const appendChild = vi.spyOn(document.body, 'appendChild');
        const removeChild = vi.spyOn(document.body, 'removeChild');

        document.getElementById('log-download-button').click();

        await vi.waitFor(() => {
            expect(anchorClick).toHaveBeenCalledOnce();
        });
        expect(globalThis.fetch).toHaveBeenCalledWith(exportUrl, {
            method: 'HEAD',
        });
        expect(clickedAnchor.getAttribute('href')).toBe(exportUrl);
        expect(clickedAnchor.download).toBe(
            `research_logs_${researchId}.jsonl`
        );
        expect(clickedAnchor.style.display).toBe('none');
        expect(appendChild).toHaveBeenCalledWith(clickedAnchor);
        expect(removeChild).toHaveBeenCalledWith(clickedAnchor);
        expect(document.body.contains(clickedAnchor)).toBe(false);
        expect(window.ui.showAlert).not.toHaveBeenCalled();
    });

    it('continues with the native download when the pre-flight request fails', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
        const anchorClick = vi
            .spyOn(window.HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => {});

        document.getElementById('log-download-button').click();

        await vi.waitFor(() => {
            expect(anchorClick).toHaveBeenCalledOnce();
        });
        expect(globalThis.fetch).toHaveBeenCalledWith(exportUrl, {
            method: 'HEAD',
        });
        expect(window.ui.showAlert).not.toHaveBeenCalled();
        expect(
            document.querySelector(
                `a[download="research_logs_${researchId}.jsonl"]`
            )
        ).toBeNull();
    });
});

describe('addLog — live pruning integration', () => {
    function setupLivePanel(renderedLimit) {
        setupPanelDom({ page: 'progress', researchId: null });
        window._logPanelState.expanded = true;
        window._logPanelState.renderedLimit = renderedLimit;

        const indicator = document.createElement('span');
        indicator.className = 'ldr-log-indicator';
        indicator.textContent = '0';
        document.getElementById('log-panel-toggle').appendChild(indicator);
        return document.getElementById('console-log-container');
    }

    function getBadge(type) {
        return Number(document.querySelector(
            `.ldr-filter-count[data-filter-count="${type}"]`
        ).textContent);
    }

    it('prunes DEBUG without affecting the lifetime count badges', () => {
        // Live panels use cumulativeCounts for the badges. DEBUG
        // maps to the untracked 'debug' bucket (not 'info'), so it
        // contributes to cumulativeTotal without bumping any of the
        // four tracked per-category badges. pruneToCap evicts the
        // DEBUG row but neither the DOM-derived counts nor the
        // cumulative counts change for DEBUG.
        const container = setupLivePanel(2);

        logPanel.addLog('debug-first', 'DEBUG');
        logPanel.addLog('warning-second', 'WARNING');
        logPanel.addLog('error-third', 'ERROR');

        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['warning', 'error']);
        // DOM-derived counts: DEBUG maps to untracked 'debug', not
        // 'info' — so info stays at 0.
        expect(window._logPanelState.counts).toEqual({
            info: 0,
            milestone: 0,
            warning: 1,
            error: 1,
        });
        // Cumulative counts: DEBUG maps to untracked bucket too.
        expect(window._logPanelState.cumulativeCounts).toEqual({
            info: 0,
            milestone: 0,
            warning: 1,
            error: 1,
        });
        // But cumulativeTotal counts every insert, including DEBUG.
        expect(window._logPanelState.cumulativeTotal).toBe(3);
        expect(getBadge('info')).toBe(0);
        expect(getBadge('warning')).toBe(1);
        expect(getBadge('error')).toBe(1);
        expect(getBadge('all')).toBe(3);
        expect(document.querySelector('.ldr-log-indicator').textContent).toBe('3');
    });

    it('does not create an inherited-key counter on live insert', () => {
        const container = setupLivePanel(1);

        logPanel.addLog('live-constructor', 'CONSTRUCTOR');

        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['constructor']);
        expect(window._logPanelState.counts).toEqual({
            info: 0,
            milestone: 0,
            warning: 0,
            error: 0,
        });
        expect(
            Object.prototype.hasOwnProperty.call(
                window._logPanelState.counts,
                'constructor'
            )
        ).toBe(false);
        expect(getBadge('all')).toBe(1);
        expect(document.querySelector('.ldr-log-indicator').textContent).toBe('1');
    });

    it('does not create counters for a prototype-named custom level', async () => {
        const container = setupLivePanel(1);
        globalThis.fetch = vi.fn()
            .mockResolvedValueOnce({
                json: () => Promise.resolve({ total_logs: 1 }),
            })
            .mockResolvedValueOnce({
                json: () => Promise.resolve({
                    logs: [{
                        timestamp: '2026-07-26T00:00:00Z',
                        message: 'custom-level-row',
                        log_type: 'CONSTRUCTOR',
                    }],
                }),
            });
        // The 3rd call is the live panel's /logs/warnings-errors
        // side fetch (added in the logpanel bidirectional refactor).
        // The endpoint isn't relevant for this assertion so an empty
        // payload is fine — the panel just needs the fetch to
        // resolve without throwing.
        globalThis.fetch.mockResolvedValueOnce({
            json: () => Promise.resolve([]),
        });

        try {
            await logPanel.loadLogs('prototype-level-research', 1);

            expect(
                Array.from(container.children).map(
                    (entry) => entry.dataset.logType
                )
            ).toEqual(['constructor']);
            // DOM-derived counts: CONSTRUCTOR is an untracked type, so
            // it doesn't bump any bucket. Both state.counts and
            // state.cumulativeCounts stay zeroed out.
            expect(window._logPanelState.counts).toEqual({
                info: 0,
                milestone: 0,
                warning: 0,
                error: 0,
            });
            expect(window._logPanelState.cumulativeCounts).toEqual({
                info: 0,
                milestone: 0,
                warning: 0,
                error: 0,
            });
            // cumulativeTotal still grew — the row WAS inserted, just
            // into a category that isn't one of the four tracked
            // buckets.
            expect(window._logPanelState.cumulativeTotal).toBe(1);

            logPanel.addLog('newer-error', 'ERROR');

            expect(
                Array.from(container.children).map(
                    (entry) => entry.dataset.logType
                )
            ).toEqual(['error']);
            expect(window._logPanelState.counts).toEqual({
                info: 0,
                milestone: 0,
                warning: 0,
                error: 1,
            });
            expect(
                Object.prototype.hasOwnProperty.call(
                    window._logPanelState.counts,
                    'constructor'
                )
            ).toBe(false);
            expect(getBadge('error')).toBe(1);
            expect(getBadge('all')).toBe(2);
            // Indicator under the new format: cumulative=2, totalLogs=1
            // → A=0 (clamped to 1), B=Y=1. Range is "showing 1\u20131 out
            // of 1 logs" because the live addLog's row stays in the
            // DOM (cumulative grew) but the persisted total doesn't
            // change.
            expect(
                document.querySelector('.ldr-log-indicator').textContent
            ).toBe('showing 1\u20131 out of 1 logs');
        } finally {
            delete globalThis.fetch;
        }
    });

    it('prunes older CRITICAL without decrementing its shared Errors counter', () => {
        // Live panels use cumulativeCounts for the badge — CRITICAL
        // and ERROR share the 'error' bucket. The lifetime count
        // grows even when the DOM row gets pruned.
        const container = setupLivePanel(1);

        logPanel.addLog('critical-first', 'CRITICAL');
        expect(window._logPanelState.counts.error).toBe(1);
        expect(getBadge('error')).toBe(1);

        logPanel.addLog('error-second', 'ERROR');

        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['error']);
        // DOM-derived counts: the CRITICAL row was pruned, so the
        // remaining 'error' bucket shows 1 (just the new ERROR).
        expect(window._logPanelState.counts).toEqual({
            info: 0,
            milestone: 0,
            warning: 0,
            error: 1,
        });
        // Cumulative: both rows contributed to the error bucket, so
        // the badge shows 2.
        expect(window._logPanelState.cumulativeCounts.error).toBe(2);
        expect(window._logPanelState.cumulativeTotal).toBe(2);
        expect(getBadge('error')).toBe(2);
        expect(getBadge('all')).toBe(2);
        expect(document.querySelector('.ldr-log-indicator').textContent).toBe('2');
    });

    it('prunes older SUCCESS without decrementing its shared Milestones counter', () => {
        const container = setupLivePanel(1);

        logPanel.addLog('success-first', 'SUCCESS');
        expect(window._logPanelState.counts.milestone).toBe(1);
        expect(getBadge('milestone')).toBe(1);

        logPanel.addLog('milestone-second', 'MILESTONE');

        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['milestone']);
        // DOM-derived: the SUCCESS row was pruned, milestone shows 1.
        expect(window._logPanelState.counts).toEqual({
            info: 0,
            milestone: 1,
            warning: 0,
            error: 0,
        });
        // Cumulative: both rows contributed to the milestone bucket.
        expect(window._logPanelState.cumulativeCounts.milestone).toBe(2);
        expect(window._logPanelState.cumulativeTotal).toBe(2);
        expect(getBadge('milestone')).toBe(2);
        expect(getBadge('all')).toBe(2);
        expect(document.querySelector('.ldr-log-indicator').textContent).toBe('2');
    });

    it('floors a fractional renderedLimit without draining the panel', () => {
        const container = setupLivePanel(2.5);

        logPanel.addLog('warning-first', 'WARNING');
        logPanel.addLog('error-second', 'ERROR');
        logPanel.addLog('info-third', 'INFO');

        expect(Array.from(container.children).map((entry) => entry.dataset.logType))
            .toEqual(['warning', 'error']);
        // DOM-derived counts: the INFO row was pruned.
        expect(window._logPanelState.counts).toEqual({
            info: 0,
            milestone: 0,
            warning: 1,
            error: 1,
        });
        // Cumulative counts: all three rows contributed before the
        // INFO one was pruned. Badges use the cumulative copy.
        expect(window._logPanelState.cumulativeCounts).toEqual({
            info: 1,
            milestone: 0,
            warning: 1,
            error: 1,
        });
        expect(window._logPanelState.cumulativeTotal).toBe(3);
        expect(getBadge('all')).toBe(3);
        expect(document.querySelector('.ldr-log-indicator').textContent).toBe('3');
    });

    it('does not collapse an expanded renderedLimit back to the default 500', () => {
        const container = setupLivePanel(501);
        for (let i = 0; i < MAX_LOG_ENTRIES; i++) {
            const entry = makeLiveEntry(`seed-${i}`, 'info');
            entry.dataset.logTimeMs = String(i);
            container.appendChild(entry);
        }
        window._logPanelState.counts.info = MAX_LOG_ENTRIES;
        document.querySelector('.ldr-log-indicator').textContent = String(MAX_LOG_ENTRIES);

        logPanel.addLog('live-after-load-older', 'error');

        // The DOM stays at the 501 cap.
        expect(container.querySelectorAll('.ldr-console-log-entry')).toHaveLength(501);
        // DOM-derived counts: one info was pruned to make room for
        // the error.
        expect(window._logPanelState.counts.info).toBe(500);
        expect(window._logPanelState.counts.error).toBe(1);
        // Cumulative: all 500 info entries were inserted via direct
        // DOM seeding (no bumpCumulative), plus the one error row
        // that went through insertLive. Badge shows 1 (only the live
        // entry contributed to the cumulative count).
        expect(window._logPanelState.cumulativeCounts.error).toBe(1);
        expect(window._logPanelState.cumulativeTotal).toBe(1);
        expect(getBadge('all')).toBe(1);
    });

    it('bypasses querySelectorAll in pruneToCap when knownCount <= cap', () => {
        const container = document.createElement('div');
        const entry = makeLiveEntry('entry-1', 'info');
        container.appendChild(entry);

        const querySpy = vi.spyOn(container, 'querySelectorAll');
        const removed = window.logPanel._pruneToCap(container, 5, 1);

        expect(removed).toEqual([]);
        expect(querySpy).not.toHaveBeenCalled();
    });

    it('queries DOM and prunes in pruneToCap when knownCount > cap', () => {
        const container = document.createElement('div');
        for (let i = 0; i < 3; i++) {
            container.appendChild(makeLiveEntry(`entry-${i}`, 'info'));
        }

        const removed = window.logPanel._pruneToCap(container, 2, 3);
        expect(removed).toEqual(['info']);
        expect(container.querySelectorAll('.ldr-console-log-entry')).toHaveLength(2);
    });

    it('queries DOM and prunes in pruneToCap when knownCount is omitted', () => {
        const container = document.createElement('div');
        for (let i = 0; i < 3; i++) {
            container.appendChild(makeLiveEntry(`entry-${i}`, 'info'));
        }

        const removed = window.logPanel._pruneToCap(container, 2);
        expect(removed).toEqual(['info']);
        expect(container.querySelectorAll('.ldr-console-log-entry')).toHaveLength(2);
    });

    it('rebuilds renderedIds from the live DOM when switching research', () => {
        const entry = makeLiveEntry('rendered-before-switch');
        document.getElementById('console-log-container').appendChild(entry);
        window._logPanelState.renderedIds.add('stale-set-only-id');

        window.logPanel.initialize('new-research-id');

        expect(window._logPanelState.renderedIds).toEqual(
            new Set(['live-rendered-before-switch'])
        );
    });
});
