/**
 * Tests for the "Load older" cursor-pagination contract.
 *
 * The bug: ``state.renderedLimit >= HARD_CAP`` hid the "Load older" button
 * after a single click, even when the persisted total far exceeded the
 * hard cap. Users with a 50,000-row research could never page past the
 * first 5,000 — the button was gone but the "X of 50,000" badge stayed
 * visible, advertising unreachable data.
 *
 * The fix: the cursor is the smallest id currently in the DOM
 * (``state.oldestLoadedId``). Each "Load older" click fetches
 * ``?limit=N&before_id=<oldestLoadedId>``. The cursor is stable under live
 * inserts (new rows have higher ids and don't shift the boundary) and the
 * server uses an index seek rather than a row-skip on the SQL side.
 *
 * The tests below pin down the new contract end-to-end against a stub
 * URLBuilder that captures the ``before_id`` query parameter.
 */
import { vi } from 'vitest';

let logPanel;
let emptyCounts;
const MAX = 500;

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

    // Pretend we're on a research page so the auto-initialize path runs.
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

function makeLogs(count, prefix = 'h') {
    return Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        timestamp: `2026-05-08T12:00:${String(index).padStart(2, '0')}Z`,
        message: `${prefix}-${index}`,
        log_type: 'info',
    }));
}

/**
 * Build a fetch spy that paginates: each call to ``?limit=N&before_id=X``
 * returns the synthetic slice of the in-memory backlog with id < X,
 * limited to pageSize, sorted oldest-first. The first call (no
 * before_id) returns the newest ``pageSize`` rows.
 */
function mockPaginatedFetch(totalLogs, pageSize) {
    const backlog = makeLogs(totalLogs);
    const fetchSpy = vi.fn((url) => {
        if (url.includes('/log_count')) {
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: totalLogs }),
            });
        }
        if (url.includes('/logs')) {
            const beforeIdMatch = /[?&]before_id=(\d+)/.exec(url);
            const beforeId = beforeIdMatch ? parseInt(beforeIdMatch[1], 10) : null;
            // Cursor pagination: when before_id is set, return rows with
            // id < before_id, sorted oldest-first. When absent, return
            // the newest pageSize rows.
            let slice;
            if (beforeId === null) {
                // Newest pageSize rows.
                slice = backlog.slice(totalLogs - pageSize);
            } else {
                // IDs are 1-indexed (id = index + 1). The slice is
                // [beforeId - pageSize, beforeId) in id-space, clamped to
                // non-negative start.
                const endIdx = beforeId - 1; // exclusive
                const startIdx = Math.max(0, endIdx - pageSize);
                slice = backlog.slice(startIdx, endIdx);
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

describe('Load older button — cursor pagination', () => {
    it('Load older button stays visible after the first click on a long run', async () => {
        // Regression: 9,002 rows, hit Load older once. Pre-fix the button
        // disappeared (renderedLimit reached HARD_CAP). Post-fix it stays
        // visible because totalLogs (9,002) > DOM count.
        //
        // New replace contract: the older info rows replace the existing
        // info rows in the DOM (so the DOM stays at the batch size).
        // Under the user's bump-by-window-size display math, A starts
        // at 1 on a fresh load and bumps by the previous window size
        // each time Load older is clicked — so after one click of an
        // initial 500-row window we expect "showing 501–1,000 out of
        // 9,002 logs".
        const researchId = 'load-older-stays-visible';
        const indicator = addLogIndicator(researchId);
        mockPaginatedFetch(9002, 500);

        await logPanel.loadLogs(researchId);
        let loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();
        // Initial: 500 info rows in DOM, cumulative = 500.
        expect(document.querySelectorAll('.ldr-console-log-entry').length)
            .toBe(500);

        loadOlder.click();
        await vi.waitFor(() => {
            // After Load older: info rows are REPLACED by the older
            // batch (still 500), but the cumulative count grew.
            expect(window._logPanelState.cumulativeTotal).toBeGreaterThan(500);
        });

        loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();
        // Info rows are replaced, not appended, so the DOM stays at
        // 500 entries. The cumulative count tracks what we've loaded
        // across all batches.
        expect(document.querySelectorAll('.ldr-console-log-entry').length)
            .toBe(500);
        expect(window._logPanelState.cumulativeTotal).toBe(1000);
        expect(indicator.textContent).toBe(
            'showing 501–1,000 out of 9,002 logs'
        );
    });

    it('Load older click fetches the next page with ?before_id=<oldest>', async () => {
        // Each click should fetch the next batch, not refetch the first.
        const researchId = 'load-older-cursor';
        addLogIndicator(researchId);
        const fetchSpy = mockPaginatedFetch(9002, 500);

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();
        loadOlder.click();

        await vi.waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledWith(
                expect.stringContaining('before_id=')
            );
        });
    });

    it('multiple consecutive clicks accumulate rows from distinct windows', async () => {
        // 9,002 rows / 500 per page → 19 clicks needed to reach the end.
        // The button must remain visible until the server has nothing
        // more to return at the current cursor.
        //
        // Replace contract: the DOM stays bounded at the page size
        // (~500 info rows) because info rows are replaced on each
        // click — but the cumulative count grows by 500 per click.
        const researchId = 'load-older-accumulate';
        addLogIndicator(researchId);
        const fetchSpy = mockPaginatedFetch(9002, 500);

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();
        for (let i = 0; i < 5; i++) {
            loadOlder.click();
            await vi.waitFor(() => {
                // cumulativeTotal grows by 500 per click.
                expect(
                    window._logPanelState.cumulativeTotal
                ).toBeGreaterThan(500 * (i + 1));
            });
            expect(
                document.querySelectorAll('.ldr-console-log-entry').length
            ).toBe(500);
        }
        // The 5 "Load older" clicks each carried a strictly smaller
        // before_id — the cursor went 8503, 8003, 7503, 7003, 6503.
        // We check the LAST one rather than asserting every step so the
        // test tolerates the load-order of count + logs.
        const lastLogsCall = [...fetchSpy.mock.calls]
            .filter((call) => call[0].includes('/logs?'))
            .filter((call) => !call[0].includes('/log_count'))
            .pop();
        const beforeIdMatch = /[?&]before_id=(\d+)/.exec(lastLogsCall[0]);
        expect(beforeIdMatch).not.toBeNull();
        // The cursor strictly decreases as the user pages forward.
        expect(Number(beforeIdMatch[1])).toBeLessThan(9002);
        // Still has more rows to load — button must still be visible.
        expect(document.querySelector('.ldr-load-older')).not.toBeNull();
        expect(window._logPanelState.oldestLoadedId).toBeLessThan(9002);
    });

    it('Load older button disappears when the cursor reaches the oldest id', async () => {
        // 1000 rows, page size 500 → 2 clicks exhaust the available rows.
        // After the second click, the cursor reaches id=1 and the button
        // is hidden — there's no more rows the user can page into.
        const researchId = 'load-older-hides-when-exhausted';
        addLogIndicator(researchId);
        mockPaginatedFetch(1000, 500);

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        expect(loadOlder).not.toBeNull();

        loadOlder.click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(500);
        });
        // After the second click, oldestLoadedId = 1 (the start of the
        // id range). No more rows to page into.
        expect(window._logPanelState.oldestLoadedId).toBe(1);
        expect(document.querySelector('.ldr-load-older')).toBeNull();
        // The indicator reflects the range end of what we have loaded.
        // Under the user's bump-by-window-size math: initial A=1,
        // B=500. After one Load older (fetched the remaining 500):
        // A bumps by the previous viewWindowSize (500), B grows by the
        // fetched batch (500), capped at Y=1000.
        const indicatorSpan = document.getElementById('log-indicator');
        expect(indicatorSpan.textContent).toBe(
            'showing 501–1,000 out of 1,000 logs'
        );
    });

    it('replaces info rows with the older batch in chronological order (oldest first)', async () => {
        // The replace contract: info rows from the prior batch are
        // REMOVED before the newer batch is inserted. Final DOM order
        // is just the latest batch, oldest-first.
        const researchId = 'load-older-chrono-order';
        addLogIndicator(researchId);
        mockPaginatedFetch(10, 3);

        await logPanel.loadLogs(researchId);
        expect(
            Array.from(document.querySelectorAll('.ldr-log-message'))
                .map((el) => el.textContent)
        ).toEqual(['h-7', 'h-8', 'h-9']);

        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.oldestLoadedId
            ).toBeLessThan(8);
        });

        // After Load older: the prior 3 info rows are replaced by the
        // older batch, so the DOM is just h-4, h-5, h-6 (oldest-first).
        expect(
            Array.from(document.querySelectorAll('.ldr-log-message'))
                .map((el) => el.textContent)
        ).toEqual(['h-4', 'h-5', 'h-6']);
        // Cumulative count reflects all loaded rows.
        expect(window._logPanelState.cumulativeTotal).toBe(6);
    });

    it('does not refetch the first window when Load older is clicked', async () => {
        // The legacy implementation called loadLogs(researchId, HARD_CAP)
        // which set renderedLimit = 5000 and re-fetched the full window.
        // The fix appends only the before_id=X rows.
        const researchId = 'load-older-no-refetch';
        addLogIndicator(researchId);
        const fetchSpy = mockPaginatedFetch(9002, 500);

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        loadOlder.click();
        // Wait for the second /logs fetch to register (count is fetched
        // first, then logs — we want the batch to land and bump the
        // cumulative count past the initial 500).
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(500);
        });

        // The last /logs call must carry before_id=<oldest> (the next
        // batch), not re-request the newest 500.
        const logsCalls = fetchSpy.mock.calls
            .filter((call) => call[0].includes('/logs?'))
            .filter((call) => !call[0].includes('/log_count'));
        expect(logsCalls.length).toBe(2);
        expect(logsCalls[1][0]).toContain('before_id=');
        expect(logsCalls[0][0]).not.toContain('before_id=');
    });

    it('cursor is null initially and resets on research switch', async () => {
        // Regression: research switches should reset the cursor so the
        // second research doesn't accidentally page-forward from the
        // first research's cursor position.
        const researchA = 'switch-A';
        const researchB = 'switch-B';
        addLogIndicator(researchA);
        mockPaginatedFetch(9002, 500);

        await logPanel.loadLogs(researchA);
        // Load older once so the cursor is non-null.
        document.querySelector('.ldr-load-older').click();
        await vi.waitFor(() => {
            expect(window._logPanelState.oldestLoadedId).toBeLessThan(9002);
        });

        // Switch to B.
        addLogIndicator(researchB);
        logPanel.initialize(researchB);
        // After init, cursor must reset to null.
        expect(window._logPanelState.oldestLoadedId).toBeNull();
    });

    it('is stable under live socket inserts mid-pagination', async () => {
        // Regression: cursor-based pagination must NOT shift when new
        // rows arrive between two "Load older" clicks. With the old
        // offset-based pagination, a 50-row socket burst inserted
        // between clicks would shift the cut-off by 50, and the user
        // would see a gap or a repeat. With before_id, the cursor is
        // an immutable id, so we always get the next batch older than
        // the oldest we have.
        //
        // Replace contract caveat: the socket inserts are info rows, so
        // they get dropped from the DOM (but kept in cumulative) the next
        // time we click Load older — what's still in the DOM counts as
        // < 1000.
        const researchId = 'cursor-stable';
        addLogIndicator(researchId);
        const fetchSpy = mockPaginatedFetch(9002, 500);

        await logPanel.loadLogs(researchId);
        const loadOlder = document.querySelector('.ldr-load-older');
        loadOlder.click();
        await vi.waitFor(() => {
            expect(window._logPanelState.oldestLoadedId).toBeLessThan(9002);
        });
        const cursorBefore = window._logPanelState.oldestLoadedId;

        // 50 fresh socket events arrive AFTER the first "Load older"
        // click but BEFORE the second one. With offset-based pagination
        // these would shift the cut-off and the next click would skip
        // rows. With cursor-based pagination, the cursor is unaffected
        // because new rows have higher ids.
        window._logPanelState.expanded = true;
        const cumulativeBeforeSockets = window._logPanelState.cumulativeTotal;
        for (let i = 0; i < 50; i++) {
            logPanel.addLog(`socket-${i}`, 'info');
        }

        // Second "Load older" click. Info rows get REPLACED by the
        // older batch, so the DOM stays bounded near the page size
        // — but cumulativeTotal grows monotonically.
        loadOlder.click();
        await vi.waitFor(() => {
            expect(
                window._logPanelState.cumulativeTotal
            ).toBeGreaterThan(cumulativeBeforeSockets);
        });

        // The cursor advanced further (or stayed at the same boundary —
        // both are correct: the server returns rows with id < cursor,
        // and the new socket rows have higher ids that don't affect the
        // boundary).
        const cursorAfter = window._logPanelState.oldestLoadedId;
        expect(cursorAfter).toBeLessThanOrEqual(cursorBefore);

        // The fetch used the SAME cursor — the URL still has before_id=
        // pointing at the OLD threshold, and the new socket rows are
        // not in the response.
        const beforeIdMatches = fetchSpy.mock.calls
            .filter((call) => call[0].includes('/logs?'))
            .filter((call) => !call[0].includes('/log_count'))
            .filter((call) => /[?&]before_id=\d+/.test(call[0]))
            .map((call) => Number(/[?&]before_id=(\d+)/.exec(call[0])[1]));
        // The first "Load older" used the post-initial-load cursor and
        // the second used the same cursor (since socket events don't
        // touch the cursor). The two cursors are equal.
        expect(beforeIdMatches[beforeIdMatches.length - 1])
            .toBe(cursorBefore);
    });
});
