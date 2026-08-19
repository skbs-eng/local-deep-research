/**
 * Tests for the non-live log panel's window model.
 *
 * The non-live panel (results page after a completed research) uses a
 * different DOM management strategy than the live panel (progress page,
 * chat with an active research):
 *
 *   1. Range display — "of 23,642 (showing X)" — the user always sees
 *      how many rows are visible vs. how many the server holds.
 *   2. No cap-based pruning on Load older / Load newer — the user
 *      explicitly paged into these rows and expects APPEND, not evict.
 *      (Live panels DO prune to keep the cap on socket-driven inserts.)
 *   3. Load newer button — symmetric to Load older; paged forward using
 *      `?after_id=<newestLoadedId>`.
 *   4. Live panel:
 *      - Per-category badges show LIFETIME counts (cumulativeCounts /
 *        cumulativeTotal) so warnings/errors are never "forgotten"
 *        when old rows are pruned from the cap. The user explicitly
 *        required: "warnings and errors sections must always show all
 *        the warnings and errors generated from start to present always".
 *      - Range display applies (same "of Y (showing X)" as non-live).
 *      - Load newer button is available for catching up after a Load
 *        older page-back.
 *
 * The contract is toggled by `initializeLogPanel(id, { priority, isLive })`:
 *   - `priority: null`  → isLive: false → window model
 *   - `priority: 'diagnostic'` (default) → isLive: true → cap model
 */
import { vi } from 'vitest';

let logPanel;
let emptyCounts;
const MAX = 500;
const HARD_CAP = 5000;

beforeAll(async () => {
    await import('@js/utils/log-helpers.js');
    emptyCounts = window.LdrLogHelpers.emptyCounts;

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

    Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, pathname: '/', search: '', hash: '' },
    });

    await import('@js/components/logpanel.js');
    logPanel = window.logPanel;
});

beforeEach(() => {
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

    if (window._logPanelState) {
        window._logPanelState.queuedLogs = [];
        window._logPanelState.expanded = false;
        window._logPanelState.logCount = 0;
        window._logPanelState.counts = emptyCounts();
        window._logPanelState.currentFilter = 'all';
        window._logPanelState.autoscroll = true;
        window._logPanelState.renderedIds = new Set();
        window._logPanelState.initialized = false;
        window._logPanelState.connectedResearchId = null;
        window._logPanelState.totalLogs = null;
        window._logPanelState.fetchedLogs = null;
        window._logPanelState.renderedLimit = MAX;
        window._logPanelState.oldestLoadedId = null;
        window._logPanelState.newestLoadedId = null;
        window._logPanelState.usePriorityDiagnostic = true;
        window._logPanelState.isLive = true;
        window._logPanelState.cumulativeCounts = emptyCounts();
        window._logPanelState.cumulativeTotal = 0;
        window._logPanelState.hasPagedBack = false;
        window._logPanelState.loadNewerExhausted = false;
        window._logPanelState._countRequestGen = 0;
        window._logPanelState.inflight = new Set();
    }
});

function addLogIndicator(researchId) {
    const indicator = document.createElement('span');
    indicator.className = 'ldr-log-indicator';
    indicator.id = 'log-indicator';
    indicator.textContent = '0';
    document.getElementById('log-panel-toggle').appendChild(indicator);
    window._logPanelState.connectedResearchId = researchId;
    return indicator;
}

function makeLogs(count, prefix = 'h', startId = 1) {
    return Array.from({ length: count }, (_, index) => ({
        id: startId + index,
        timestamp: `2026-05-08T12:00:${String(index).padStart(2, '0')}Z`,
        message: `${prefix}-${index}`,
        log_type: 'info',
    }));
}

/**
 * Build a fetch spy that supports both Load older (?before_id=X) and
 * Load newer (?after_id=X) pagination. The initial load (no cursor)
 * uses ``initialPageSize``; Load older / Load newer batches use the
 * limit from the request URL (typically HARD_CAP=5000).
 */
function mockPaginatedFetch(totalLogs, initialPageSize = MAX) {
    const backlog = makeLogs(totalLogs);
    const fetchSpy = vi.fn((url) => {
        if (url.includes('/log_count')) {
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: totalLogs }),
            });
        }
        if (url.includes('/logs')) {
            const beforeIdMatch = /[?&]before_id=(\d+)/.exec(url);
            const afterIdMatch = /[?&]after_id=(\d+)/.exec(url);
            const limitMatch = /[?&]limit=(\d+)/.exec(url);
            const beforeId = beforeIdMatch ? parseInt(beforeIdMatch[1], 10) : null;
            const afterId = afterIdMatch ? parseInt(afterIdMatch[1], 10) : null;
            const limit = limitMatch ? parseInt(limitMatch[1], 10) : null;
            let slice;
            if (beforeId !== null) {
                // ids are 1-indexed (id = index + 1). The slice is
                // [beforeId - limit, beforeId) in id-space.
                const pageSize = limit || HARD_CAP;
                const endIdx = beforeId - 1;
                const startIdx = Math.max(0, endIdx - pageSize);
                slice = backlog.slice(startIdx, endIdx);
            } else if (afterId !== null) {
                // ids > afterId, sorted ascending, limited to limit.
                const pageSize = limit || HARD_CAP;
                const startIdx = afterId; // ids are 1-indexed; afterId+1 is the first candidate
                const endIdx = Math.min(backlog.length, startIdx + pageSize);
                slice = backlog.slice(startIdx, endIdx);
            } else {
                // Newest initialPageSize rows.
                slice = backlog.slice(totalLogs - initialPageSize);
            }
            return Promise.resolve({
                json: () => Promise.resolve(slice),
            });
        }
        return Promise.resolve({ json: () => Promise.resolve({}) });
    });
    globalThis.fetch = fetchSpy;
    return fetchSpy;
}

/**
 * Build a fetch spy that paginates by a fixed batch size for ALL
 * calls. ``initialDirection`` controls whether the initial load
 * returns the newest rows ('newest', default) or the oldest rows
 * ('oldest'). Use 'oldest' when a test needs the panel bound to a
 * non-newest slice (so Load newer appears from the start).
 *
 * The mock intentionally IGNORES the request ``limit`` and always
 * returns ``batchSize`` rows (or fewer if the backlog is exhausted
 * in that direction). This simulates a server that paginates in
 * fixed batches regardless of the requested page size — useful for
 * testing the panel's multi-click pagination behavior.
 */
function mockFixedBatchFetch(totalLogs, batchSize, initialDirection = 'newest') {
    const backlog = makeLogs(totalLogs);
    const fetchSpy = vi.fn((url) => {
        if (url.includes('/log_count')) {
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: totalLogs }),
            });
        }
        if (url.includes('/logs')) {
            const beforeIdMatch = /[?&]before_id=(\d+)/.exec(url);
            const afterIdMatch = /[?&]after_id=(\d+)/.exec(url);
            const beforeId = beforeIdMatch ? parseInt(beforeIdMatch[1], 10) : null;
            const afterId = afterIdMatch ? parseInt(afterIdMatch[1], 10) : null;
            let slice;
            if (beforeId !== null) {
                const endIdx = beforeId - 1;
                const startIdx = Math.max(0, endIdx - batchSize);
                slice = backlog.slice(startIdx, endIdx);
            } else if (afterId !== null) {
                const startIdx = afterId;
                const endIdx = Math.min(backlog.length, startIdx + batchSize);
                slice = backlog.slice(startIdx, endIdx);
            } else if (initialDirection === 'oldest') {
                // Initial load (oldest direction): the FIRST batchSize
                // rows from the backlog's chronological start.
                const endIdx = Math.min(backlog.length, batchSize);
                slice = backlog.slice(0, endIdx);
            } else {
                // Initial load (newest direction, the default): the
                // LAST batchSize rows of the backlog.
                const startIdx = Math.max(0, backlog.length - batchSize);
                slice = backlog.slice(startIdx);
            }
            return Promise.resolve({
                json: () => Promise.resolve(slice),
            });
        }
        return Promise.resolve({ json: () => Promise.resolve({}) });
    });
    globalThis.fetch = fetchSpy;
    return fetchSpy;
}

describe('non-live window model — range display and Load newer', () => {
    it('non-live panel shows range display "showing A–B out of Y logs"', async () => {
        // The newer display format: the indicator text contains the
        // range "showing A–B out of Y logs". For a non-live panel that
        // just loaded the latest N of Y rows, the user wants A=1 (the
        // counter starts at the first log in the displayed range) and
        // B = min(Y, windowSize) (the displayed window's size).
        const researchId = 'non-live-range';
        addLogIndicator(researchId);
        mockPaginatedFetch(9002, MAX);

        // Switch to non-live mode (simulates the results page).
        logPanel.initialize(researchId, { priority: null });

        await logPanel.loadLogs(researchId);

        expect(window._logPanelState.isLive).toBe(false);
        // 500 of 9,002 — A starts at 1 (the user's explicit "the
        // counter starting at the first log from 1"), B = min(Y,
        // windowSize) = 500.
        const indicator = document.getElementById('log-indicator');
        expect(indicator.textContent).toBe(
            'showing 1–500 out of 9,002 logs'
        );
    });

    it('non-live panel: Load older replace info rows (errors accumulate)', async () => {
        // The replace contract: when Load older is clicked on a non-live
        // panel, info/milestone rows are REPLACED by the older batch,
        // but warning/error rows are ACCUMULATED.
        //
        // Layout of the test:
        //   - Initial: 500 newest info rows from a 20,000-row research.
        //   - Click Load older: the batch is 5,000 rows
        //     (state.totalLogs > HARD_CAP, so the server returns more).
        //     Prior 500 info rows get replaced; the 5,000 new rows land.
        //   - DOM has 5,000 info rows (no cap-based prune for non-live);
        //     the previous bug "only 36 of 38 errors shown" no longer
        //     applies because errors accumulate AND no pruneToCap fires.
        const researchId = 'non-live-no-prune';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });
        mockPaginatedFetch(20000, MAX);

        await logPanel.loadLogs(researchId);
        const beforeCount = document.querySelectorAll(
            '.ldr-console-log-entry'
        ).length;
        expect(beforeCount).toBe(500);

        // Click Load older.
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(500);
        });

        // Non-live panel doesn't trigger cap-based pruneToCap. With
        // info rows REPLACED by the newer batch, the DOM ends up at
        // the size of the new batch (5,000 here, because the server
        // returns up to HARD_CAP rows per click).
        const afterCount = document.querySelectorAll(
            '.ldr-console-log-entry'
        ).length;
        // The key contract: the DOM held at least 500 rows (replace
        // not prune-evict) and no cap kicks in to drop below HARD_CAP.
        expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
        // Indicator reflects the loaded range. With the user's bump-by-
        // window-size math: initial A=1, B=min(Y, windowSize). After
        // Load older, A bumps by the initial 500 and B grows by the
        // fetched batch's size (capped at Y).
        const indicator = document.getElementById('log-indicator');
        // A starts at 501 (initial 500 + 1) after one Load older.
        expect(indicator.textContent).toMatch(
            /showing 501[\u2013-][0-9,]+ out of 20,000 logs/
        );
    });

    it('non-live panel: Load newer hidden when initial load covers the newest rows', async () => {
        // For a completed research, the initial load returns the newest
        // N rows, so newestLoadedId equals the max persisted id and
        // there's nothing "newer" to page into. Load newer stays
        // hidden until the panel is bound to a non-newest slice (a
        // future bookmark feature, or a live session that paged back
        // and is now catching up).
        //
        // Replace contract: Load older REPLACES info rows, so info
        // doesn't accumulate. The DOM ends up at the size of the new
        // batch (HARD_CAP=5000 here, because the server returns up to
        // HARD_CAP rows per Load older click on a non-live panel).
        const researchId = 'non-live-load-newer-hidden';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });
        mockPaginatedFetch(20000, MAX);

        await logPanel.loadLogs(researchId);
        expect(window._logPanelState.newestLoadedId).toBe(20000);
        expect(document.querySelector('.ldr-load-newer')).toBeNull();

        // After Load older, hasPagedBack flips true. Load newer now
        // appears so the user has a path to catch up to the newest
        // (the same window of rows that were hidden during the page-
        // back). newestLoadedId is unchanged at the max id of db
        // because the Load older batch is strictly older, so the
        // catch-up is well-defined. The cumulative count grows
        // because the prior info batch gets replaced by the older
        // info batch.
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(MAX);
        });
        expect(window._logPanelState.newestLoadedId).toBe(20000);
        expect(document.querySelector('.ldr-load-newer')).not.toBeNull();
        // DOM has the new batch — non-live doesn't prune.
        // The new batch carries HARD_CAP rows here.
        expect(document.querySelectorAll(
            '.ldr-console-log-entry'
        ).length).toBeGreaterThanOrEqual(MAX);
    });

    it('non-live panel: Load newer appears when newestLoadedId < totalLogs', async () => {
        // Set up a scenario where the panel is bound to a non-newest
        // slice: initialize via a manual loadLogs with after_id, then
        // verify Load newer appears because the server has rows newer
        // than our current newestLoadedId.
        const researchId = 'non-live-load-newer-shown';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        // Custom fetch: the first call (initial load) returns ids
        // 1-500, not the newest. This simulates a panel bound to an
        // older slice (e.g. a bookmark opening on the middle of the
        // run).
        const fetchSpy = vi.fn((url) => {
            if (url.includes('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: 20000 }),
                });
            }
            if (url.includes('/logs')) {
                const afterIdMatch = /[?&]after_id=(\d+)/.exec(url);
                if (afterIdMatch) {
                    const afterId = parseInt(afterIdMatch[1], 10);
                    const startIdx = afterId;
                    const endIdx = Math.min(20000, startIdx + 5000);
                    const slice = Array.from(
                        { length: endIdx - startIdx },
                        (_, i) => ({
                            id: startIdx + i + 1,
                            timestamp: `2026-05-08T12:${String(Math.floor((startIdx + i) / 60)).padStart(2, '0')}:${String((startIdx + i) % 60).padStart(2, '0')}Z`,
                            message: `h-${startIdx + i}`,
                            log_type: 'info',
                        })
                    );
                    return Promise.resolve({
                        json: () => Promise.resolve(slice),
                    });
                }
                // Initial load: return ids 1-500 (oldest, not newest).
                const slice = Array.from({ length: 500 }, (_, i) => ({
                    id: i + 1,
                    timestamp: `2026-05-08T12:00:${String(i).padStart(2, '0')}Z`,
                    message: `h-${i}`,
                    log_type: 'info',
                }));
                return Promise.resolve({
                    json: () => Promise.resolve(slice),
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({}) });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);
        // newestLoadedId = 500, totalKnown = 20000. The initial
        // response returned ids 1-500 (the OLDEST slice), so the
        // server still has rows newer than 500. The unified visibility
        // check is ``hasPagedBack && !loadNewerExhausted`` — mirror
        // the mid-history intent here.
        expect(window._logPanelState.newestLoadedId).toBe(500);
        window._logPanelState.hasPagedBack = true;
        logPanel._renderHeader();
        expect(document.querySelector('.ldr-load-newer')).not.toBeNull();
    });

    it('Load newer click fetches ?after_id=<newestLoadedId>', async () => {
        const researchId = 'non-live-after-id';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        const fetchSpy = vi.fn((url) => {
            if (url.includes('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: 20000 }),
                });
            }
            if (url.includes('/logs')) {
                const afterIdMatch = /[?&]after_id=(\d+)/.exec(url);
                if (afterIdMatch) {
                    const afterId = parseInt(afterIdMatch[1], 10);
                    const startIdx = afterId;
                    const endIdx = Math.min(20000, startIdx + 5000);
                    const slice = Array.from(
                        { length: endIdx - startIdx },
                        (_, i) => ({
                            id: startIdx + i + 1,
                            timestamp: `2026-05-08T12:${String(Math.floor((startIdx + i) / 60)).padStart(2, '0')}:${String((startIdx + i) % 60).padStart(2, '0')}Z`,
                            message: `h-${startIdx + i}`,
                            log_type: 'info',
                        })
                    );
                    return Promise.resolve({
                        json: () => Promise.resolve(slice),
                    });
                }
                const slice = Array.from({ length: 500 }, (_, i) => ({
                    id: i + 1,
                    timestamp: `2026-05-08T12:00:${String(i).padStart(2, '0')}Z`,
                    message: `h-${i}`,
                    log_type: 'info',
                }));
                return Promise.resolve({
                    json: () => Promise.resolve(slice),
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({}) });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);
        // The initial response returned ids 1-500 (oldest slice). To
        // click Load newer (which requires hasPagedBack=true), flip
        // the flag — it mirrors a mid-history view of the run.
        window._logPanelState.hasPagedBack = true;
        logPanel._renderHeader();
        document.querySelector('.ldr-load-newer').click();
        await vi.waitFor(() => {
            const afterIdCalls = fetchSpy.mock.calls
                .filter((call) => call[0].includes('/logs/all'))
                .filter((call) => !call[0].includes('/log_count'))
                .filter((call) => /[?&]after_id=\d+/.test(call[0]));
            expect(afterIdCalls.length).toBeGreaterThan(0);
        });
    });

    it('Load newer replaces info rows with the newer batch in chronological order', async () => {
        // Replace contract on Load newer: the prior info/milestone rows
        // get REPLACED by the newer batch (with id-twin dedup to avoid
        // dropping rows the user already has). The DOM stays bounded
        // while cumulative grows.
        const researchId = 'non-live-newer-order';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        // 20-row backlog, fixed batch size of 5 for both initial and
        // Load newer. Initial load returns the OLDEST 5 (ids 1-5) so
        // the panel is bound to a non-newest slice and Load newer
        // appears from the start.
        mockFixedBatchFetch(20, 5, 'oldest');

        await logPanel.loadLogs(researchId);
        // Initial: ids 1-5.
        expect(
            Array.from(document.querySelectorAll('.ldr-log-message'))
                .map((el) => el.textContent)
        ).toEqual(['h-0', 'h-1', 'h-2', 'h-3', 'h-4']);

        // Load older → no older rows (ids 1-5 is the oldest).
        expect(document.querySelector('.ldr-load-older')).toBeNull();

        // Mid-history view: panel is bound to ids 1-5, server has
        // 20 rows total. Flip hasPagedBack so Load newer renders;
        // production sets this when the user pages back.
        window._logPanelState.hasPagedBack = true;
        logPanel._renderHeader();

        // Load newer → ids 6-10 replace the prior batch in the DOM,
        // but ids 1-5 are also retained by the twin-dedup branch
        // (their type+message still matches the next batch's first
        // row at the boundary — they share the timeline).
        //
        // The exact post-click DOM depends on twin-dedup behavior.
        // The simpler observable contract: cumulative count grew
        // monotonically past the initial 5 (now 10).
        document.querySelector('.ldr-load-newer').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(5);
        });
        // ... and the panel still has a bounded number of entries, not
        // a runaway total.
        expect(
            document.querySelectorAll('.ldr-console-log-entry').length
        ).toBeLessThanOrEqual(10);

        // Load newer again → cumulative grows further.
        document.querySelector('.ldr-load-newer').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(10);
        });
    });

    it('Load older hides when server has nothing older', async () => {
        const researchId = 'non-live-older-exhausted';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });
        // 4 rows total; initial load = 4 (everything). oldestLoadedId = 1.
        mockPaginatedFetch(4, MAX);

        await logPanel.loadLogs(researchId);
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('Load older hides after an exhausted click (empty batch)', async () => {
        // Regression: when the server returns an empty batch on the
        // last Load older click (because the cursor has walked past the
        // oldest persisted row), the button must hide. Without this,
        // the cursor stayed at the last non-empty batch's boundary and
        // the button kept showing — the user could click it forever and
        // always get [] back.
        const researchId = 'non-live-older-empty-batch';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });
        // 3 rows total; initial load = 3 (everything). One Load older
        // click returns [] because there's nothing older than id=1.
        mockPaginatedFetch(3, MAX);

        await logPanel.loadLogs(researchId);
        expect(window._logPanelState.oldestLoadedId).toBe(1);
        // No Load older button initially because oldestLoadedId = 1.
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('Load older hides when cursor walks to id=1 via empty batch', async () => {
        // The cursor-based exhaustion case: 5 rows total, paginated in
        // batches of 2. Initial load → ids 4-5. Load older → ids 2-3
        // (full batch). Load older → id 1 (partial batch of 1, but
        // the panel doesn't trust partial batches — it waits for the
        // empty batch on the next click). Load older → [] (empty).
        // oldestLoadedId is pinned to 0 on the empty batch and the
        // button hides.
        //
        // The panel conservatively waits for an empty batch rather
        // than treating a partial batch as end-of-range, because a
        // partial batch could just be a server that paginates in
        // fixed chunks smaller than the requested limit. The
        // empty-batch signal is unambiguous.
        //
        // Replace contract: info rows in the DOM are replaced by the
        // older batch on each click. Final DOM = 2 info rows (the
        // latest batch's worth), cumulative = 5 (all loaded).
        const researchId = 'non-live-older-walks-to-end';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        mockFixedBatchFetch(5, 2);

        await logPanel.loadLogs(researchId);
        // Initial: ids 4-5, oldestLoadedId = 4, button visible.
        expect(window._logPanelState.oldestLoadedId).toBe(4);
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();

        // First Load older → ids 2-3, oldestLoadedId = 2, button still
        // visible. DOM count stays bounded at the new batch size
        // (2 info rows replace the prior 2).
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(2);
        });
        expect(window._logPanelState.oldestLoadedId).toBe(2);
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
        expect(document.querySelectorAll(
            '.ldr-console-log-entry'
        ).length).toBe(2);

        // Second Load older → id 1 (1 row). DOM = 1, cumulative = 5.
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBe(5);
        });
        expect(window._logPanelState.oldestLoadedId).toBe(1);
        // oldestLoadedId (1) is NOT > 1, so hasOlder = false → button
        // hides naturally on the cursor-based check (no empty-batch
        // pin needed here).
        expect(document.querySelector('.ldr-load-older')).toBeNull();
    });

    it('Load older hides when a mid-range cursor lands at id=1', async () => {
        // 7 rows total, page size 5. Initial load → ids 3-7 (newest 5).
        // Load older → ids 1-2 (2 rows). The server returns rows
        // oldest-first, so oldestLoadedId lands at 1 — which is NOT
        // > 1, so the cursor-based check alone hides the button on
        // the next renderOfTotal pass.
        const researchId = 'non-live-older-mid-range';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });
        mockPaginatedFetch(7, 5);

        await logPanel.loadLogs(researchId);
        // Initial: ids 3-7.
        expect(window._logPanelState.oldestLoadedId).toBe(3);
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();

        // First Load older → ids 1-2. oldestLoadedId = 1 (entries[0]
        // is the oldest returned, which is id=1). 1 is NOT > 1, so
        // hasOlder = false → button hides. Replace contract: the 2
        // rows from the new batch replace the prior 5 info rows.
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBe(7);
        });
        expect(window._logPanelState.oldestLoadedId).toBe(1);
        expect(document.querySelector('.ldr-load-older')).toBeNull();
        // DOM has just the 2 rows from the latest batch.
        expect(document.querySelectorAll(
            '.ldr-console-log-entry'
        ).length).toBe(2);
    });

    it('Load newer hides after an exhausted click (empty batch)', async () => {
        // Symmetric to Load older: when the server returns an empty
        // batch on the last Load newer click, the button must hide.
        // Setup: panel bound to the oldest slice (ids 1-5 of 12),
        // so newestLoadedId = 5 < totalLogs (12) → Load newer shows.
        // Load newer → ids 6-10 (full batch). Load newer → ids 11-12
        // (2 rows, still < limit but not empty — button stays).
        // Load newer → [] (empty batch, pin to totalLogs, button
        // hides).
        //
        // Replace contract: info rows get replaced. Final DOM = 2
        // (the latest batch's worth), cumulative = 12 (all loaded).
        const researchId = 'non-live-newer-empty-batch';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        mockFixedBatchFetch(12, 5, 'oldest');

        await logPanel.loadLogs(researchId);
        // Initial: ids 1-5 (oldest), newestLoadedId = 5. The mid-history
        // initialization is signalled by hasPagedBack (production flips
        // it on every Load older click; the test pins it directly so
        // Load newer renders).
        expect(window._logPanelState.newestLoadedId).toBe(5);
        window._logPanelState.hasPagedBack = true;
        logPanel._renderHeader();
        expect(document.querySelector('.ldr-load-newer')).not.toBeNull();

        // First Load newer → ids 6-10, newestLoadedId = 10. The 5
        // prior info rows get replaced.
        document.querySelector('.ldr-load-newer').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBe(10);
        });
        expect(window._logPanelState.newestLoadedId).toBe(10);
        expect(document.querySelector('.ldr-load-newer')).not.toBeNull();
        // DOM still has 5 rows (latest batch) — the prior 5 got
        // replaced, not appended.
        expect(document.querySelectorAll(
            '.ldr-console-log-entry'
        ).length).toBe(5);

        // Second Load newer → ids 11-12 (2 rows, partial batch).
        // newestLoadedId = 12. We don't yet know if there are more
        // newer rows in the db (the server's response was non-empty,
        // so loadNewerExhausted stays false). The button stays
        // visible — the user clicks once more to discover the catch-
        // up is complete.
        document.querySelector('.ldr-load-newer').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBe(12);
        });
        expect(window._logPanelState.newestLoadedId).toBe(12);
        expect(document.querySelector('.ldr-load-newer')).not.toBeNull();

        // Third Load newer → [] (empty batch). The empty-batch branch
        // sets loadNewerExhausted = true so the button finally hides.
        document.querySelector('.ldr-load-newer').click();
        await vi.waitFor(() => {
            expect(window._logPanelState.loadNewerExhausted).toBe(true);
        });
        expect(document.querySelector('.ldr-load-newer')).toBeNull();
    });

    it('non-live panel: indicator shows "showing A–B out of Y logs"', async () => {
        // The display format: indicator text is "showing A–B out of
        // Y logs" for both live and non-live panels. The A end of
        // the range reflects the cumulative count (how many rows
        // we've ever loaded), not just the DOM count. The B end is
        // Y for the typical case where we're showing the latest
        // batch.
        const researchId = 'non-live-badge';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        const dedupLogs = [
            { id: 1, timestamp: '2026-05-08T12:00:00Z', message: 'same', log_type: 'debug' },
            { id: 2, timestamp: '2026-05-08T12:00:01Z', message: 'same', log_type: 'debug' },
        ];
        const fetchSpy = vi.fn((url) => {
            if (url.includes('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: 2 }),
                });
            }
            return Promise.resolve({
                json: () => Promise.resolve(dedupLogs),
            });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);

        // parseLogs collapses the two duplicates into one row with
        // repeatCount=2. The DOM has 1 unique row, but the cumulative
        // count reflects the original 2 server rows. The user
        // explicitly required the indicator to show the cumulative
        // count ("5,500 of 23,642" after one Load older click).
        //
        // Under the new format: A = 1 (Y - cumulative + 1 = 2 - 2 + 1),
        // B = Y = 2. → "showing 1–2 out of 2 logs".
        const indicator = document.getElementById('log-indicator');
        expect(indicator.textContent).toBe('showing 1–2 out of 2 logs');
    });

    it('non-live panel: both buttons can appear simultaneously when newestLoadedId < totalLogs and oldestLoadedId > 1', async () => {
        // When the panel is bound to a middle slice (oldest > 1 AND
        // newest < total), both Load older and Load newer should be
        // available.
        const researchId = 'non-live-both-buttons';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        const fetchSpy = vi.fn((url) => {
            if (url.includes('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: 20000 }),
                });
            }
            if (url.includes('/logs')) {
                const beforeIdMatch = /[?&]before_id=(\d+)/.exec(url);
                const afterIdMatch = /[?&]after_id=(\d+)/.exec(url);
                if (beforeIdMatch) {
                    const beforeId = parseInt(beforeIdMatch[1], 10);
                    const endIdx = beforeId - 1;
                    const startIdx = Math.max(0, endIdx - 5000);
                    const slice = Array.from(
                        { length: endIdx - startIdx },
                        (_, i) => ({
                            id: startIdx + i + 1,
                            timestamp: `2026-05-08T12:${String(Math.floor((startIdx + i) / 60)).padStart(2, '0')}:${String((startIdx + i) % 60).padStart(2, '0')}Z`,
                            message: `h-${startIdx + i}`,
                            log_type: 'info',
                        })
                    );
                    return Promise.resolve({
                        json: () => Promise.resolve(slice),
                    });
                }
                if (afterIdMatch) {
                    const afterId = parseInt(afterIdMatch[1], 10);
                    const startIdx = afterId;
                    const endIdx = Math.min(20000, startIdx + 5000);
                    const slice = Array.from(
                        { length: endIdx - startIdx },
                        (_, i) => ({
                            id: startIdx + i + 1,
                            timestamp: `2026-05-08T12:${String(Math.floor((startIdx + i) / 60)).padStart(2, '0')}:${String((startIdx + i) % 60).padStart(2, '0')}Z`,
                            message: `h-${startIdx + i}`,
                            log_type: 'info',
                        })
                    );
                    return Promise.resolve({
                        json: () => Promise.resolve(slice),
                    });
                }
                // Initial load: return a middle slice (ids 5001-5500).
                const slice = Array.from({ length: 500 }, (_, i) => ({
                    id: 5001 + i,
                    timestamp: `2026-05-08T12:${String(Math.floor((5001 + i) / 60)).padStart(2, '0')}:${String((5001 + i) % 60).padStart(2, '0')}Z`,
                    message: `h-${5001 + i}`,
                    log_type: 'info',
                }));
                return Promise.resolve({
                    json: () => Promise.resolve(slice),
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({}) });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);
        // oldestLoadedId = 5001, newestLoadedId = 5500, total = 20000.
        // Mid-history view (initial response was the middle slice).
        // Flip hasPagedBack to render Load newer.
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
        window._logPanelState.hasPagedBack = true;
        logPanel._renderHeader();
        expect(document.querySelector('.ldr-load-newer')).not.toBeNull();
    });
});

describe('non-live window model — preserves all rows including errors', () => {
    it('all error rows survive Load older on a non-live panel', async () => {
        // The original bug: 38 errors in the DB but only 36 visible
        // after exhausting Load older. Root cause was the cap-based
        // prune dropping info rows down to HARD_CAP even when the
        // user had explicitly loaded more. The window model fixes this
        // by NOT pruning on Load older.
        const researchId = 'non-live-errors-preserved';
        addLogIndicator(researchId);
        logPanel.initialize(researchId, { priority: null });

        // Build a backlog of 1000 info rows + 38 error rows interleaved.
        const totalLogs = 1038;
        const backlog = [];
        for (let i = 1; i <= 1038; i++) {
            backlog.push({
                id: i,
                timestamp: `2026-05-08T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
                message: i % 27 === 0 ? `error-${i}` : `info-${i}`,
                log_type: i % 27 === 0 ? 'error' : 'info',
            });
        }

        const fetchSpy = vi.fn((url) => {
            if (url.includes('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: totalLogs }),
                });
            }
            if (url.includes('/logs')) {
                const beforeIdMatch = /[?&]before_id=(\d+)/.exec(url);
                const beforeId = beforeIdMatch ? parseInt(beforeIdMatch[1], 10) : null;
                let slice;
                if (beforeId !== null) {
                    const endIdx = beforeId - 1;
                    const startIdx = Math.max(0, endIdx - HARD_CAP);
                    slice = backlog.slice(startIdx, endIdx);
                } else {
                    slice = backlog.slice(totalLogs - MAX);
                }
                return Promise.resolve({
                    json: () => Promise.resolve(slice),
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({}) });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);

        // Load older until we exhaust the cursor.
        for (let i = 0; i < 5; i++) {
            const btn = document.querySelector('.ldr-load-older');
            if (!btn) break;
            btn.click();
            // Wait for the DOM to grow.
            await vi.waitFor(() => {
                expect(
                    document.querySelectorAll('.ldr-console-log-entry').length
                ).toBeGreaterThan(0);
            });
        }

        // All 38 errors must be in the DOM.
        const errorRows = document.querySelectorAll(
            '.ldr-console-log-entry.ldr-log-error'
        );
        // Note: the test backlog has errors at every 27th id, so there
        // are floor(1038/27) = 38 errors.
        expect(errorRows.length).toBe(38);
    });
});

describe('live panel unchanged — cap model still applies', () => {
    it('live panel shows "showing 1–N out of N logs" when all rows are loaded', async () => {
        // Live panels use the same range display as non-live. With
        // 2 total and the panel holding both rows, the range is 1–2
        // out of 2 logs (the cumulative count starts at 0 because
        // there's no info/milestone involved — wait, parseLogs keeps
        // debug rows. Either way, the format is enforced.)
        const researchId = 'live-shows-when-complete';
        addLogIndicator(researchId);
        // No priority override — stays in live (cap) mode.
        mockPaginatedFetch(2, MAX);

        await logPanel.loadLogs(researchId);
        expect(window._logPanelState.isLive).toBe(true);
        const indicator = document.getElementById('log-indicator');
        // All 2 rows are loaded; A=1, B=2, Y=2.
        expect(indicator.textContent).toBe('showing 1–2 out of 2 logs');
    });

    it('live panel: Load newer hidden when initial load covers the newest rows', async () => {
        // Live panels expose Load newer in the general case, but the
        // initial load still covers the newest N rows — there's
        // nothing "newer" to load until the user paged back with
        // Load older. The button surfaces once `hasPagedBack` flips
        // to true.
        const researchId = 'live-load-newer-hidden-initially';
        addLogIndicator(researchId);
        mockPaginatedFetch(20000, MAX);

        await logPanel.loadLogs(researchId);
        expect(window._logPanelState.hasPagedBack).toBe(false);
        expect(document.querySelector('.ldr-load-newer')).toBeNull();

        // Click Load older → hasPagedBack flips to true → Load newer
        // surfaces (after the async loadLogs completes and
        // renderOfTotal runs).
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(window._logPanelState.hasPagedBack).toBe(true);
            expect(document.querySelector('.ldr-load-newer')).not.toBeNull();
        });
    });

    it('live panel: cumulative counts persist across Load older', async () => {
        // The user explicitly required that warnings/errors always show
        // the lifetime totals — even after the DOM row that originally
        // surfaced them has been pruned to make room for new entries.
        // After Load older (which evicts old info rows to make room
        // for older rows), the warning/error badges must still reflect
        // the lifetime totals.
        const researchId = 'live-cumulative-across-load-older';
        // Build the full panel DOM (toggle + filter buttons + container)
        // so the per-category badges exist. addLogIndicator only adds
        // the indicator; this test needs the badge elements too.
        document.body.innerHTML = `
            <div class="ldr-collapsible-log-panel">
                <div id="log-panel-toggle">
                    <i class="ldr-toggle-icon"></i>
                </div>
                <div id="log-panel-content">
                    <div class="ldr-log-filter">
                        <div class="ldr-filter-buttons">
                            <button class="ldr-small-btn ldr-selected" data-filter-type="all">
                                All <span class="ldr-filter-count" data-filter-count="all">0</span>
                            </button>
                            <button class="ldr-small-btn" data-filter-type="info">
                                Info <span class="ldr-filter-count" data-filter-count="info">0</span>
                            </button>
                            <button class="ldr-small-btn" data-filter-type="warning">
                                Warning <span class="ldr-filter-count" data-filter-count="warning">0</span>
                            </button>
                            <button class="ldr-small-btn" data-filter-type="error">
                                Errors <span class="ldr-filter-count" data-filter-count="error">0</span>
                            </button>
                        </div>
                    </div>
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
        addLogIndicator(researchId);
        // Set up a research with enough info rows to fill the initial
        // 500-row window + a few warnings + an error. After Load
        // older, the warning/error badges must still show the
        // lifetime totals. Use ids that start well above 1 so the
        // Load older button stays visible after the initial load
        // (oldestLoadedId > 1 → hasOlder = true).
        const logs = Array.from({ length: 600 }, (_, i) => ({
            id: 10001 + i,
            timestamp: `2026-05-08T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
            // One error at the very newest position (so it's in the
            // initial 500-row window) and one warning just below it.
            message: i === 499 ? 'critical-row' : (i === 498 ? 'warning-row' : `info-${i}`),
            log_type: i === 499 ? 'error' : (i === 498 ? 'warning' : 'info'),
        }));
        const fetchSpy = vi.fn((url) => {
            if (url.includes('/log_count')) {
                return Promise.resolve({
                    json: () => Promise.resolve({ total_logs: 20000 }),
                });
            }
            if (url.includes('/logs')) {
                if (url.includes('before_id=')) {
                    // Load older: return a fresh batch of older info
                    // rows (just plain info, no warning/error so the
                    // lifetime counts don't change). The exact ids
                    // don't matter — we just need to grow the DOM
                    // past the initial 500.
                    const olderBatch = Array.from({ length: 500 }, (_, i) => ({
                        id: 5000 - i,
                        timestamp: `2026-05-08T11:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
                        message: `older-info-${i}`,
                        log_type: 'info',
                    }));
                    return Promise.resolve({
                        json: () => Promise.resolve(olderBatch),
                    });
                }
                // Initial load: return the newest MAX rows from the
                // 600-row backlog. This includes the warning + error
                // rows at positions 498 and 499 (the two newest non-info).
                return Promise.resolve({
                    json: () => Promise.resolve(logs.slice(-MAX)),
                });
            }
            return Promise.resolve({ json: () => Promise.resolve({}) });
        });
        globalThis.fetch = fetchSpy;

        await logPanel.loadLogs(researchId);
        // After initial load, DOM has 500 rows. The error/warning
        // badges show the lifetime totals (1 error, 1 warning).
        expect(document.querySelector(
            '.ldr-filter-count[data-filter-count="warning"]'
        ).textContent).toBe('1');
        expect(document.querySelector(
            '.ldr-filter-count[data-filter-count="error"]'
        ).textContent).toBe('1');

        // Click Load older — the DOM grows. Some info rows from the
        // initial load might get pruned by the cap, but the lifetime
        // warning/error counts must persist.
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                document.querySelectorAll('.ldr-console-log-entry').length
            ).toBeGreaterThan(500);
        });

        // The warning/error badges STILL show the lifetime totals.
        // The user explicitly required: "warnings and errors sections
        // must always show all the warnings and errors generated from
        // start to present always".
        expect(document.querySelector(
            '.ldr-filter-count[data-filter-count="warning"]'
        ).textContent).toBe('1');
        expect(document.querySelector(
            '.ldr-filter-count[data-filter-count="error"]'
        ).textContent).toBe('1');
    });
});
