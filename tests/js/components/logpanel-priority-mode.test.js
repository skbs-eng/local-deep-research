/**
 * Tests for the live-vs-non-live routing added in the WIP logpanel revision.
 *
 * Background: the frontend log panel routes its /logs fetches to one of two
 * dedicated endpoints depending on whether the bound research is still
 * running:
 *
 *   - Live (progress page, chat with an active research)
 *     → ``/api/research/<id>/logs``. The server picks a window biased
 *     toward errors / warnings / milestones so they surface above
 *     routine noise while the run is in flight.
 *
 *   - Non-live (results page, after a completed research)
 *     → ``/api/research/<id>/logs/all``. A priority-free sibling
 *     endpoint; the run is over and the user wants the actual newest
 *     N rows plain, not a triage list.
 *
 * The user explicitly chose this URL-level split over a query-param
 * toggle (priority=diagnostic on a single endpoint). It keeps each URL
 * truly uniform — the priority bias is structurally impossible from
 * the non-live side because the server-side code path for that route
 * never applies it.
 *
 * The endpoint choice is driven by the ``isLive`` flag on
 * ``initialize``. The legacy ``priority`` option is preserved for
 * backwards compatibility (priority=null → isLive=false → /logs/all;
 * priority=<anything> → isLive=true → /logs).
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
        window._logPanelState.newestLoadedId = null;
        window._logPanelState.isLive = true;
        window._logPanelState.cumulativeCounts = emptyCounts();
        window._logPanelState.cumulativeTotal = 0;
        window._logPanelState.hasPagedBack = false;
        window._logPanelState.loadNewerExhausted = false;
    }
});

function captureFetch() {
    const fetchSpy = vi.fn(() =>
        Promise.resolve({
            json: () => Promise.resolve([]),
        })
    );
    globalThis.fetch = fetchSpy;
    return fetchSpy;
}

describe('live mode (priority-bearing endpoint)', () => {
    it('default initialize routes to the live endpoint', async () => {
        const researchId = 'live-default';
        const fetchSpy = captureFetch();
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        expect(window._logPanelState.isLive).toBe(true);
        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        // Live route: /api/research/<id>/logs (the priority endpoint).
        expect(logsCall[0]).toBe(
            `/api/research/${researchId}/logs?limit=500`
        );
    });

    it('explicit isLive=true routes to the live endpoint', async () => {
        const researchId = 'live-explicit-on';
        const fetchSpy = captureFetch();
        logPanel.initialize(researchId, { isLive: true });
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        expect(logsCall[0]).toBe(
            `/api/research/${researchId}/logs?limit=500`
        );
    });

    it('the legacy priority option still routes correctly (priority=dianostic → live)', async () => {
        // The progress page passes {priority: 'diagnostic'} from the
        // auto-init handler that survived the endpoint split. The
        // option survives as a backwards-compat alias: any truthy value
        // routes to the live endpoint.
        const researchId = 'live-priority-on';
        const fetchSpy = captureFetch();
        logPanel.initialize(researchId, { priority: 'diagnostic' });
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        expect(logsCall[0]).toBe(
            `/api/research/${researchId}/logs?limit=500`
        );
    });
});

describe('non-live mode (priority-free endpoint)', () => {
    it('priority=null routes to the /logs/all endpoint', async () => {
        const researchId = 'non-live-priority-null';
        const fetchSpy = captureFetch();
        // Re-init with priority disabled (simulates the results page).
        logPanel.initialize(researchId, { priority: null });
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        expect(window._logPanelState.isLive).toBe(false);
        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        // Non-live route: /api/research/<id>/logs/all (priority-free).
        // The endpoint is structurally incapable of priority biasing.
        expect(logsCall[0]).toBe(
            `/api/research/${researchId}/logs/all?limit=500`
        );
    });

    it('explicit isLive=false routes to the /logs/all endpoint', async () => {
        const researchId = 'non-live-isLive-false';
        const fetchSpy = captureFetch();
        logPanel.initialize(researchId, { isLive: false });
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        expect(logsCall[0]).toBe(
            `/api/research/${researchId}/logs/all?limit=500`
        );
    });

    it('state.isLive tracks the isLive option', async () => {
        logPanel.initialize('isLive-track-1', { isLive: true });
        expect(window._logPanelState.isLive).toBe(true);

        logPanel.initialize('isLive-track-2', { isLive: false });
        expect(window._logPanelState.isLive).toBe(false);
    });

    it('isLive flag is preserved across research switches on the same page', async () => {
        // Switching from research A to research B on the same page
        // must not flip the priority mode (it's a per-page concern).
        const researchA = 'switch-A';
        const researchB = 'switch-B';

        logPanel.initialize(researchA, { priority: null });
        expect(window._logPanelState.isLive).toBe(false);

        // Switch to B (different research id, same page).
        logPanel.initialize(researchB);
        expect(window._logPanelState.isLive).toBe(false);
    });
});

describe('end-to-end: live and non-live URLs do not bleed', () => {
    it('results page fetch URL goes to /logs/all and omits priority parameter', async () => {
        const researchId = 'results-rid';
        const fetchSpy = captureFetch();
        logPanel.initialize(researchId, { priority: null });
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        // The endpoint itself is priority-free — there's no
        // priority=diagnostic query param to send. The URL is
        // completely uniform.
        expect(logsCall[0]).not.toContain('priority=diagnostic');
        expect(logsCall[0]).toMatch(/\/logs\/all/);
    });

    it('progress page fetch URL goes to /logs (live endpoint)', async () => {
        const researchId = 'progress-rid';
        const fetchSpy = captureFetch();
        logPanel.initialize(researchId, { priority: 'diagnostic' });
        window._logPanelState.connectedResearchId = researchId;

        await logPanel.loadLogs(researchId);

        const logsCall = fetchSpy.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        expect(logsCall[0]).toBe(
            `/api/research/${researchId}/logs?limit=500`
        );
        expect(window._logPanelState.isLive).toBe(true);
    });

    it('live and non-live URLs are distinct — neither leaks into the other', async () => {
        // Pins the user's invariant: the live endpoint and the
        // priority-free endpoint are distinct URLs that should
        // never appear on the opposite mode. A regression that
        // hardcodes the old /logs path in the non-live branch would
        // cause this test to fail.
        const fetchLive = captureFetch();
        logPanel.initialize('live-rid', { priority: 'diagnostic' });
        window._logPanelState.connectedResearchId = 'live-rid';
        await logPanel.loadLogs('live-rid');
        const liveCall = fetchLive.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        expect(liveCall[0]).toBe('/api/research/live-rid/logs?limit=500');

        const fetchNonLive = captureFetch();
        logPanel.initialize('non-live-rid', { priority: null });
        window._logPanelState.connectedResearchId = 'non-live-rid';
        await logPanel.loadLogs('non-live-rid');
        const nonLiveCall = fetchNonLive.mock.calls.find(
            (call) =>
                call[0].includes('/logs') &&
                !call[0].includes('/log_count')
        );
        expect(nonLiveCall[0]).toBe(
            '/api/research/non-live-rid/logs/all?limit=500'
        );
    });
});
