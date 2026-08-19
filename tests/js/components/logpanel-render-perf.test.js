/**
 * Tests for the render-path optimizations.
 *
 * Two optimizations were applied to the render paths:
 *
 * 1. **Cached template root** — ``makeRow`` now clones the parsed
 *    ``<template>`` root (via ``cloneNode(true)``) instead of doing
 *    ``importNode(template.content, true)`` per row. The cache is
 *    populated lazily on the first call and reused for every
 *    subsequent row in the same page lifetime.
 *
 * 2. **Single DOM snapshot in ``mergeBatch``** — the previous code
 *    called ``c.querySelectorAll('.ldr-console-log-entry')`` once per
 *    entry inside the loop (N queries per batch) and rescanned from
 *    the start for every insertion (O(N×M) total). The new code
 *    snapshots the live DOM once, captures the timestamp array, and
 *    walks the entries with a forward-only insertion index — O(N+M)
 *    total — leveraging the fact that entries are sorted ascending
 *    and the live DOM is already sorted ascending.
 *
 * The tests below pin the correctness of these optimizations against
 * edge cases that the original slow code passed by accident, to make
 * sure the optimization didn't break them.
 */
import { vi } from 'vitest';

let logPanel;
let emptyCounts;

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
        window._logPanelState.renderedLimit = 500;
        window._logPanelState.oldestLoadedId = null;
    }
});

/**
 * Build a heterogeneous fetch mock that returns the right shape for each
 * endpoint. The "logs" callback is invoked for the /logs endpoint.
 */
function mockFetchFor({ total, logs }) {
    const fetchSpy = vi.fn((url) => {
        if (url.includes('/log_count')) {
            return Promise.resolve({
                json: () => Promise.resolve({ total_logs: total }),
            });
        }
        if (url.includes('/logs')) {
            return Promise.resolve({
                json: () => Promise.resolve(logs),
            });
        }
        return Promise.resolve({ json: () => Promise.resolve({}) });
    });
    globalThis.fetch = fetchSpy;
    return fetchSpy;
}

function makeEntry(message, type, timestamp) {
    return {
        id: `live-${message}`,
        time: new Date(timestamp).toISOString(),
        message,
        type,
        metadata: { type },
    };
}

function appendLiveDirect(entry) {
    // Bypass the addLog queue by setting expanded=true so the entry
    // flows through insertLive directly into the DOM. The timestamp is
    // whatever the system clock says now (Date.now() / new Date()).
    window._logPanelState.expanded = true;
    logPanel.addLog(entry.message, entry.type);
}

describe('mergeBatch — chronological order under edge cases', () => {

    it('preserves chronological order when fetched entries are newer than all live entries', async () => {
        // We can't easily set the live entry's timestamp via addLog
        // (it uses Date.now() internally), so verify the order by
        // checking that the live entries (with the test's now-time)
        // come before the fetched entries (with the explicit timestamps).
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        appendLiveDirect(makeEntry('live-1', 'info', '2026-05-08T12:00:00Z'));
        appendLiveDirect(makeEntry('live-2', 'info', '2026-05-08T12:00:00Z'));
        appendLiveDirect(makeEntry('live-3', 'info', '2026-05-08T12:00:00Z'));
        vi.useRealTimers();

        const fetched = [
            { id: 'f1', timestamp: '2026-05-08T12:00:04Z', message: 'fetch-1', log_type: 'info' },
            { id: 'f2', timestamp: '2026-05-08T12:00:05Z', message: 'fetch-2', log_type: 'info' },
            { id: 'f3', timestamp: '2026-05-08T12:00:06Z', message: 'fetch-3', log_type: 'info' },
        ];
        mockFetchFor({ total: 6, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const order = Array.from(
            container.querySelectorAll('.ldr-console-log-entry')
        ).map((n) => n.dataset.logMessage);
        // 3 live + 3 fetched = 6 rows in chronological order.
        expect(order).toEqual([
            'live-1', 'live-2', 'live-3',
            'fetch-1', 'fetch-2', 'fetch-3',
        ]);
    });

    it('preserves chronological order when fetched entries are older than all live entries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-08T12:00:05Z'));
        appendLiveDirect(makeEntry('live-1', 'info', '2026-05-08T12:00:05Z'));
        appendLiveDirect(makeEntry('live-2', 'info', '2026-05-08T12:00:05Z'));
        vi.useRealTimers();

        const fetched = [
            { id: 'f1', timestamp: '2026-05-08T12:00:01Z', message: 'old-1', log_type: 'info' },
            { id: 'f2', timestamp: '2026-05-08T12:00:02Z', message: 'old-2', log_type: 'info' },
            { id: 'f3', timestamp: '2026-05-08T12:00:03Z', message: 'old-3', log_type: 'info' },
        ];
        mockFetchFor({ total: 5, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const order = Array.from(
            container.querySelectorAll('.ldr-console-log-entry')
        ).map((n) => n.dataset.logMessage);
        expect(order).toEqual([
            'old-1', 'old-2', 'old-3',
            'live-1', 'live-2',
        ]);
    });

    it('preserves chronological order with mixed older/newer fetched entries', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-08T12:00:03Z'));
        appendLiveDirect(makeEntry('live-A', 'info', '2026-05-08T12:00:03Z'));
        appendLiveDirect(makeEntry('live-B', 'info', '2026-05-08T12:00:04Z'));
        vi.useRealTimers();

        const fetched = [
            { id: 'f1', timestamp: '2026-05-08T12:00:01Z', message: 'old-1', log_type: 'info' },
            { id: 'f2', timestamp: '2026-05-08T12:00:02Z', message: 'old-2', log_type: 'info' },
            { id: 'f3', timestamp: '2026-05-08T12:00:05Z', message: 'new-1', log_type: 'info' },
            { id: 'f4', timestamp: '2026-05-08T12:00:06Z', message: 'new-2', log_type: 'info' },
        ];
        mockFetchFor({ total: 6, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const order = Array.from(
            container.querySelectorAll('.ldr-console-log-entry')
        ).map((n) => n.dataset.logMessage);
        expect(order).toEqual([
            'old-1', 'old-2',
            'live-A', 'live-B',
            'new-1', 'new-2',
        ]);
    });

    it('handles entries with identical timestamps without losing order', async () => {
        // Three entries share the same timestamp T. The insertion scan
        // must keep them in input order — the new entry lands after the
        // existing one with the same timestamp.
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        appendLiveDirect(makeEntry('live-1', 'info', '2026-05-08T12:00:00Z'));
        vi.useRealTimers();

        const fetched = [
            { id: 'f1', timestamp: '2026-05-08T12:00:00Z', message: 'tie-1', log_type: 'info' },
            { id: 'f2', timestamp: '2026-05-08T12:00:00Z', message: 'tie-2', log_type: 'info' },
        ];
        mockFetchFor({ total: 3, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const order = Array.from(
            container.querySelectorAll('.ldr-console-log-entry')
        ).map((n) => n.dataset.logMessage);
        // 'live-1' comes first, then the two new entries.
        expect(order).toEqual(['live-1', 'tie-1', 'tie-2']);
    });
});

describe('mergeBatch — content-dedup still works after the snapshot refactor', () => {
    it('skips routine entries that duplicate the most recent live entry', async () => {
        // Live entries: 'heartbeat' at T1 (info).
        // Fetched entries: 'heartbeat' at T2 (info) — same message, same
        // type, within the 10-newest dedup window. Should be skipped.
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        logPanel.addLog('heartbeat', 'info');
        window._logPanelState.expanded = true;
        const fetched = [
            {
                id: 'h1',
                timestamp: '2026-05-08T12:00:01Z',
                message: 'heartbeat',
                log_type: 'info',
            },
        ];
        mockFetchFor({ total: 1, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const entries = container.querySelectorAll('.ldr-console-log-entry');
        // Only the live entry should be in the DOM — the fetched
        // duplicate is skipped.
        expect(entries.length).toBe(1);
        expect(entries[0].dataset.logMessage).toBe('heartbeat');
    });

    it('does NOT dedup non-routine entries (errors/milestones) even when content matches', async () => {
        // Regression: the content-dedup window only applies to routine
        // info/debug entries. Errors and milestones must always insert
        // (they carry recency signal that the dedup would hide).
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        appendLiveDirect(makeEntry('retry-failed', 'warning', '2026-05-08T12:00:00Z'));
        vi.useRealTimers();

        const fetched = [
            {
                id: 'w1',
                timestamp: '2026-05-08T12:00:01Z',
                message: 'retry-failed',
                log_type: 'warning',
            },
        ];
        mockFetchFor({ total: 2, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const entries = container.querySelectorAll('.ldr-console-log-entry');
        expect(entries.length).toBe(2);
    });
});

describe('cached template — produces well-formed rows', () => {
    it('first and subsequent rows share the same structure', async () => {
        // The cache is populated on the first makeRow call. We spin up
        // the panel through a loadLogs and check that every row has the
        // same set of populated child nodes.
        const fetched = Array.from({ length: 10 }, (_, i) => ({
            id: `r${i}`,
            timestamp: `2026-05-08T12:00:${String(i).padStart(2, '0')}Z`,
            message: `row-${i}`,
            log_type: 'info',
        }));
        mockFetchFor({ total: 10, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        const rows = container.querySelectorAll('.ldr-console-log-entry');
        expect(rows.length).toBe(10);
        for (const row of rows) {
            expect(row.querySelector('.ldr-log-timestamp')).not.toBeNull();
            expect(row.querySelector('.ldr-log-badge')).not.toBeNull();
            expect(row.querySelector('.ldr-log-message')).not.toBeNull();
            expect(row.dataset.logType).toBe('info');
            expect(row.dataset.logId).toBeDefined();
        }
    });

    it('cached template reuse does not leak rows between loads', async () => {
        // The cache is a singleton — its nodes are reused via cloneNode
        // for every row. After a load, the DOM should hold exactly the
        // number of rows we asked for, not a multiple of clones.
        const fetched = Array.from({ length: 5 }, (_, i) => ({
            id: `r${i}`,
            timestamp: `2026-05-08T12:00:${String(i).padStart(2, '0')}Z`,
            message: `row-${i}`,
            log_type: 'info',
        }));
        mockFetchFor({ total: 5, logs: fetched });
        await logPanel.loadLogs('test-research');

        const container = document.getElementById('console-log-container');
        expect(container.querySelectorAll('.ldr-console-log-entry').length)
            .toBe(5);
    });
});
