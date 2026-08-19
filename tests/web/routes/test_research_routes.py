# allow: no-sut-import — black-box HTTP test; drives real routes through the Flask test client
"""Tests for research_routes module - Research page and API endpoints."""

from datetime import timedelta
from unittest.mock import patch, MagicMock


# Research routes are registered under root level
RESEARCH_PREFIX = ""

# Common patch target prefix for research_routes module
_RR = "local_deep_research.web.routes.research_routes"


class TestProgressPage:
    """Tests for /progress/<research_id> endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/progress/test-id")
        assert response.status_code == 302, response.status_code

    def test_returns_page_when_authenticated(self, authenticated_client):
        """Should return progress page when authenticated."""
        with patch(
            "local_deep_research.web.routes.research_routes.render_template_with_defaults"
        ) as mock_render:
            mock_render.return_value = "<html>Progress</html>"
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/progress/test-id"
            )
            assert response.status_code == 200
            mock_render.assert_called_once_with("pages/progress.html")


class TestResearchDetailsPage:
    """Tests for /details/<research_id> endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/details/test-id")
        assert response.status_code == 302, response.status_code

    def test_returns_page_when_authenticated(self, authenticated_client):
        """Should return details page when authenticated."""
        with patch(
            "local_deep_research.web.routes.research_routes.render_template_with_defaults"
        ) as mock_render:
            mock_render.return_value = "<html>Details</html>"
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/details/test-id"
            )
            assert response.status_code == 200
            mock_render.assert_called_once_with("pages/details.html")


class TestResultsPage:
    """Tests for /results/<research_id> endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/results/test-id")
        assert response.status_code == 302, response.status_code

    def test_returns_page_when_authenticated(self, authenticated_client):
        """Should return results page when authenticated."""
        with patch(
            "local_deep_research.web.routes.research_routes.render_template_with_defaults"
        ) as mock_render:
            mock_render.return_value = "<html>Results</html>"
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/results/test-id"
            )
            assert response.status_code == 200
            mock_render.assert_called_once_with("pages/results.html")


class TestHistoryPage:
    """Tests for /history endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/history")
        assert response.status_code == 302, response.status_code

    def test_returns_page_when_authenticated(self, authenticated_client):
        """Should return history page when authenticated."""
        with patch(
            "local_deep_research.web.routes.research_routes.render_template_with_defaults"
        ) as mock_render:
            mock_render.return_value = "<html>History</html>"
            response = authenticated_client.get(f"{RESEARCH_PREFIX}/history")
            assert response.status_code == 200
            mock_render.assert_called_once_with("pages/history.html")


class TestSettingsPage:
    """Tests for /settings endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/settings")
        assert response.status_code == 302, response.status_code

    def test_returns_page_when_authenticated(self, authenticated_client):
        """Should return settings page when authenticated."""
        with patch(
            "local_deep_research.web.routes.research_routes.render_template_with_defaults"
        ) as mock_render:
            mock_render.return_value = "<html>Settings</html>"
            response = authenticated_client.get(f"{RESEARCH_PREFIX}/settings")
            assert response.status_code == 200
            mock_render.assert_called_once_with("settings_dashboard.html")


class TestMainConfigPage:
    """Tests for /settings/main endpoint (now redirects via settings blueprint)."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/settings/main")
        assert response.status_code == 302, response.status_code

    def test_redirects_when_authenticated(self, authenticated_client):
        """Should redirect to settings dashboard."""
        response = authenticated_client.get(f"{RESEARCH_PREFIX}/settings/main")
        assert response.status_code == 302


class TestCollectionsConfigPage:
    """Tests for /settings/collections endpoint (now redirects via settings blueprint)."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/settings/collections")
        assert response.status_code == 302, response.status_code

    def test_redirects_when_authenticated(self, authenticated_client):
        """Should redirect to settings dashboard."""
        response = authenticated_client.get(
            f"{RESEARCH_PREFIX}/settings/collections"
        )
        assert response.status_code == 302


class TestApiKeysConfigPage:
    """Tests for /settings/api_keys endpoint (now redirects via settings blueprint)."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/settings/api_keys")
        assert response.status_code == 302, response.status_code

    def test_redirects_when_authenticated(self, authenticated_client):
        """Should redirect to settings dashboard."""
        response = authenticated_client.get(
            f"{RESEARCH_PREFIX}/settings/api_keys"
        )
        assert response.status_code == 302


class TestSearchEnginesConfigPage:
    """Tests for /settings/search_engines endpoint (now redirects via settings blueprint)."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/settings/search_engines")
        assert response.status_code == 302, response.status_code

    def test_redirects_when_authenticated(self, authenticated_client):
        """Should redirect to settings dashboard."""
        response = authenticated_client.get(
            f"{RESEARCH_PREFIX}/settings/search_engines"
        )
        assert response.status_code == 302


class TestLlmConfigPage:
    """Tests for /settings/llm endpoint (now redirects via settings blueprint)."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/settings/llm")
        assert response.status_code == 302, response.status_code

    def test_redirects_when_authenticated(self, authenticated_client):
        """Should redirect to settings dashboard."""
        response = authenticated_client.get(f"{RESEARCH_PREFIX}/settings/llm")
        assert response.status_code == 302


class TestRedirectStatic:
    """Tests for /redirect-static/<path> endpoint."""

    def test_redirects_to_static(self, authenticated_client):
        """Should redirect to static URL."""
        with patch(f"{_RR}.url_for", return_value="/static/js/app.js"):
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/redirect-static/js/app.js"
            )
            # Should return a redirect response
            assert response.status_code == 302


class TestStartResearchApi:
    """Tests for /api/start_research endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.post(
            f"{RESEARCH_PREFIX}/api/start_research",
            json={"query": "test query"},
        )
        assert response.status_code == 401, response.status_code

    def test_returns_401_without_session(self, authenticated_client):
        """Should return 401 when session has no username."""
        # Clear the session username
        with authenticated_client.session_transaction() as sess:
            sess.pop("username", None)

        response = authenticated_client.post(
            f"{RESEARCH_PREFIX}/api/start_research",
            json={"query": "test query"},
        )
        # Expects 401 since username is not in session
        assert response.status_code == 401

    def test_requires_json_body(self, authenticated_client):
        """Should require JSON body."""
        response = authenticated_client.post(
            f"{RESEARCH_PREFIX}/api/start_research",
            data="not json",
            content_type="text/plain",
        )
        # Should return error for non-JSON body
        assert response.status_code == 400, response.status_code


class TestTerminateResearchApi:
    """Tests for /api/terminate/<research_id> endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.post(f"{RESEARCH_PREFIX}/api/terminate/test-id")
        assert response.status_code == 401, response.status_code

    def test_returns_success_when_authenticated(self, authenticated_client):
        """Should handle terminate request when authenticated."""
        mock_research = MagicMock()
        mock_research.status = "in_progress"
        mock_session = MagicMock()
        mock_session.query.return_value.filter_by.return_value.first.return_value = mock_research
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.post(
                f"{RESEARCH_PREFIX}/api/terminate/test-id"
            )
            assert response.status_code == 200, response.status_code


class TestDeleteResearchApi:
    """Tests for /api/delete/<research_id> endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.delete(f"{RESEARCH_PREFIX}/api/delete/test-id")
        assert response.status_code == 401, response.status_code

    def test_returns_success_when_authenticated(self, authenticated_client):
        """Should handle delete request when authenticated."""
        mock_research = MagicMock()
        mock_research.status = "completed"
        mock_research.report_path = None
        mock_session = MagicMock()
        mock_session.query.return_value.filter_by.return_value.first.return_value = mock_research
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.delete(
                f"{RESEARCH_PREFIX}/api/delete/test-id"
            )
            assert response.status_code == 200, response.status_code


class TestClearHistoryApi:
    """Tests for /api/clear_history endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.post(f"{RESEARCH_PREFIX}/api/clear_history")
        assert response.status_code == 401, response.status_code

    def test_returns_success_when_authenticated(self, authenticated_client):
        """Should handle clear history request when authenticated."""
        mock_session = MagicMock()
        mock_session.query.return_value.all.return_value = []
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.post(
                f"{RESEARCH_PREFIX}/api/clear_history"
            )
            assert response.status_code == 200, response.status_code


class TestGetHistoryApi:
    """Tests for /api/history endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/api/history")
        assert response.status_code == 401, response.status_code

    def test_returns_history_when_authenticated(self, authenticated_client):
        """Should return history when authenticated."""
        mock_session = MagicMock()
        mock_session.query.return_value.order_by.return_value.limit.return_value.offset.return_value.all.return_value = []
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/history"
            )
            assert response.status_code == 200, response.status_code

    def test_pagination_is_clamped(self, authenticated_client):
        """/api/history must bound its result set: ?limit=-1 (which SQLite
        treats as "no limit") is clamped to >= 1 and offset to >= 0 so the
        endpoint can't load the whole history into memory (#4560)."""
        mock_session = MagicMock()
        mock_session.query.return_value.order_by.return_value.limit.return_value.offset.return_value.all.return_value = []
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/history?limit=-1&offset=-5"
            )
            assert response.status_code == 200, response.status_code

        records_q = mock_session.query.return_value.order_by.return_value
        records_q.limit.assert_called_once_with(1)
        records_q.limit.return_value.offset.assert_called_once_with(0)

    def test_query_projects_columns_not_full_entity(self, authenticated_client):
        """/api/history must project only metadata columns, never the
        full ResearchHistory entity — querying the entity eagerly loads
        the large report_content Text body into memory. Regression guard
        for #4560 (a revert to query(ResearchHistory) is output-identical
        and would otherwise pass silently)."""
        from local_deep_research.database.models import ResearchHistory

        mock_session = MagicMock()
        mock_session.query.return_value.order_by.return_value.limit.return_value.offset.return_value.all.return_value = []
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/history"
            )
            assert response.status_code == 200, response.status_code

        # Identity checks: a SQLAlchemy column's __eq__ builds a SQL clause,
        # so `in`/`==` membership tests are unsafe here. Inspect EVERY query()
        # call (not a positional index) so the guard stays robust if queries
        # are reordered/added: the listing must never load the full
        # ResearchHistory entity or its report_content body in any of them.
        all_selected = [
            arg
            for call in mock_session.query.call_args_list
            for arg in call.args
        ]
        assert not any(arg is ResearchHistory for arg in all_selected), (
            "get_history must not query the full ResearchHistory entity"
        )
        assert not any(
            arg is ResearchHistory.report_content for arg in all_selected
        ), "get_history must not load the report_content body"


class TestGetResearchDetailsApi:
    """Tests for /api/research/<id> endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/api/research/test-id")
        assert response.status_code == 401, response.status_code

    def test_returns_details_when_authenticated(self, authenticated_client):
        """Should return research details when authenticated."""
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.first.return_value = None
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/research/test-id"
            )
            assert response.status_code == 404, response.status_code


class TestGetResearchLogsApi:
    """Tests for /api/research/<id>/logs endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/api/research/test-id/logs")
        assert response.status_code == 401, response.status_code

    def test_returns_logs_when_authenticated(self, authenticated_client):
        """Should return research logs when authenticated."""
        mock_session = MagicMock()
        mock_session.query.return_value.filter_by.return_value.first.return_value = None
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/research/test-id/logs"
            )
            assert response.status_code == 404, response.status_code

    @staticmethod
    def _seed_real_session(num_logs, same_timestamp=False):
        """Build an in-memory SQLite session with one ResearchHistory row
        (id ``test-rid``) and ``num_logs`` ResearchLog rows (messages
        ``Log 0``..``Log N-1``, inserted oldest-first so the autoincrement
        ``id`` rises with the message index). Returns the live session so the
        route is driven through real SQL — a mocked query chain returns a fixed
        list regardless of ``desc()``/``limit()`` and so cannot prove the
        newest-N ordering.

        Rows are spaced 1 minute apart unless ``same_timestamp`` is set, in
        which case every row shares one timestamp — used to prove the ``id``
        tie-break makes the newest-N selection deterministic.
        """
        from datetime import datetime, timedelta, timezone

        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from local_deep_research.database.models import (
            Base,
            ResearchHistory,
            ResearchLog,
        )

        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()

        session.add(
            ResearchHistory(
                id="test-rid",
                query="q",
                mode="quick",
                status="completed",
                created_at="2025-01-01T00:00:00+00:00",
            )
        )
        base_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
        for i in range(num_logs):
            offset = timedelta(0) if same_timestamp else timedelta(minutes=i)
            session.add(
                ResearchLog(
                    research_id="test-rid",
                    timestamp=base_time + offset,
                    message=f"Log {i}",
                    module="test",
                    function="test",
                    line_no=i,
                    level="INFO",
                )
            )
        session.commit()
        return session

    @staticmethod
    def _close_session(session):
        """Close the session AND dispose its in-memory engine, so the
        underlying sqlite connection is released (otherwise the pool keeps
        it open and pytest reports a ResourceWarning)."""
        engine = session.get_bind()
        session.close()
        if engine is not None:
            engine.dispose()

    def _get_logs(self, authenticated_client, session, query):
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            return authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/research/test-rid/logs{query}"
            )

    def _get_logs_all(self, authenticated_client, session, query):
        """Hit the priority-free ``/api/research/<id>/logs/all`` endpoint.

        Used to verify the non-live log panel route: same pagination as
        ``/api/research/<id>/logs`` but with no diagnostic triage and no
        priority branch in the SQL.
        """
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            return authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all{query}"
            )

    def test_no_limit_returns_all_logs_oldest_first(self, authenticated_client):
        """Omitting ?limit preserves the public contract: every row, asc."""
        session = self._seed_real_session(10)
        try:
            resp = self._get_logs(authenticated_client, session, "")
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == [f"Log {i}" for i in range(10)]
        finally:
            self._close_session(session)

    def test_limit_returns_newest_n_oldest_first(self, authenticated_client):
        """?limit=N returns the newest N rows, still oldest-first."""
        session = self._seed_real_session(10)
        try:
            resp = self._get_logs(authenticated_client, session, "?limit=3")
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == ["Log 7", "Log 8", "Log 9"]
        finally:
            self._close_session(session)

    def test_limit_is_clamped_to_at_least_one(self, authenticated_client):
        """?limit=0 clamps up to 1 -> just the single newest row."""
        session = self._seed_real_session(10)
        try:
            resp = self._get_logs(authenticated_client, session, "?limit=0")
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == ["Log 9"]
        finally:
            self._close_session(session)

    def test_malformed_limit_falls_back_to_all_logs(self, authenticated_client):
        """A non-integer ?limit (Flask ``type=int`` yields None) is treated as
        absent, preserving the return-all contract rather than erroring."""
        session = self._seed_real_session(10)
        try:
            resp = self._get_logs(authenticated_client, session, "?limit=abc")
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == [f"Log {i}" for i in range(10)]
        finally:
            self._close_session(session)

    def test_negative_limit_clamps_to_one(self, authenticated_client):
        """?limit=-5 clamps to 1 — NOT SQLite's ``LIMIT -1`` (= unbounded).
        The clamp runs before ``.limit()``, so a negative value can never
        reach SQL as a no-op limit."""
        session = self._seed_real_session(10)
        try:
            resp = self._get_logs(authenticated_client, session, "?limit=-5")
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == ["Log 9"]
        finally:
            self._close_session(session)

    def test_limit_above_hard_cap_is_clamped(self, authenticated_client):
        """?limit above HISTORY_LOGS_HARD_CAP is clamped to the cap. The cap
        is patched to a small value so the clamp is observable without seeding
        thousands of rows."""
        session = self._seed_real_session(10)
        try:
            with patch(f"{_RR}.HISTORY_LOGS_HARD_CAP", 2):
                resp = self._get_logs(
                    authenticated_client, session, "?limit=999999"
                )
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == ["Log 8", "Log 9"]
        finally:
            self._close_session(session)

    def test_tie_break_on_equal_timestamps_is_deterministic(
        self, authenticated_client
    ):
        """When rows share a timestamp, ``id`` tie-breaks so ?limit selects the
        highest-id (most recently inserted) rows deterministically — without
        the secondary key the surviving rows at the boundary are SQL-undefined.
        Log i has id i+1, so newest-3-by-id is Log 7/8/9, oldest-first."""
        session = self._seed_real_session(10, same_timestamp=True)
        try:
            resp = self._get_logs(authenticated_client, session, "?limit=3")
            assert resp.status_code == 200, resp.status_code
            messages = [r["message"] for r in resp.get_json()]
            assert messages == ["Log 7", "Log 8", "Log 9"]
        finally:
            self._close_session(session)

    # ------------------------------------------------------------------
    # ?before_id= cursor pagination — the recommended way for the log
    # panel to walk past HISTORY_LOGS_HARD_CAP. Stable under live inserts
    # (new rows have higher ids and don't shift the cursor) and uses an
    # index seek instead of a row-skip on the SQL side.
    # ------------------------------------------------------------------

    def test_before_id_zero_equivalent_to_default_limit(
        self, authenticated_client
    ):
        """``?before_id=0`` is the newest window — same data as omitting
        both ``before_id`` and ``offset``."""
        session = self._seed_real_session(10)
        try:
            with_cursor = self._get_logs(
                authenticated_client, session, "?limit=3&before_id=0"
            )
            without_cursor = self._get_logs(
                authenticated_client, session, "?limit=3"
            )
            assert with_cursor.status_code == 200
            assert without_cursor.status_code == 200
            assert with_cursor.get_json() == without_cursor.get_json()
        finally:
            self._close_session(session)

    def test_before_id_returns_strictly_older_rows(self, authenticated_client):
        """``?limit=N&before_id=X`` returns the next N rows strictly
        older than id X, oldest-first."""
        session = self._seed_real_session(10)
        try:
            # The seeded rows have ids 1..10 (id = i + 1). Filter
            # after the truth: a caller who has loaded rows 1..10
            # and wants the next 500 (which don't exist) sends
            # before_id=1. With the cursor parameterized by id, the
            # response is rows with id < 1, which is [].
            past = self._get_logs(
                authenticated_client, session, "?limit=5&before_id=1"
            )
            assert past.get_json() == []
            # Querying rows older than id=6 returns ids 1..5.
            older = self._get_logs(
                authenticated_client, session, "?limit=10&before_id=6"
            )
            assert [r["message"] for r in older.get_json()] == [
                f"Log {i}" for i in range(5)
            ]
        finally:
            self._close_session(session)

    def test_before_id_walks_past_history_logs_hard_cap(
        self, authenticated_client
    ):
        """Regression test for the "Load older" bug. With the hard cap
        patched to 3, a 12-row research gives 4 pages of size 3. The
        cursor-based pagination uses the oldest id of each page as the
        next page's before_id, so the caller never asks for a row it's
        already seen — no gap, no repeat, even if the server is
        concurrently inserting new rows."""
        session = self._seed_real_session(12)
        try:
            with patch(f"{_RR}.HISTORY_LOGS_HARD_CAP", 3):
                # Rows have ids 1..12. Walk from the newest forward.
                # Page 1: before_id=0 (i.e. omit) → newest 3 = ids 10,11,12.
                page1 = self._get_logs(
                    authenticated_client, session, "?limit=3&before_id=0"
                )
                cursor1 = page1.get_json()[0]["id"]
                # Page 2: before_id=<oldest of page1> → next 3.
                page2 = self._get_logs(
                    authenticated_client,
                    session,
                    f"?limit=3&before_id={cursor1}",
                )
                cursor2 = page2.get_json()[0]["id"]
                page3 = self._get_logs(
                    authenticated_client,
                    session,
                    f"?limit=3&before_id={cursor2}",
                )
                cursor3 = page3.get_json()[0]["id"]
                page4 = self._get_logs(
                    authenticated_client,
                    session,
                    f"?limit=3&before_id={cursor3}",
                )
            assert [r["message"] for r in page1.get_json()] == [
                "Log 9",
                "Log 10",
                "Log 11",
            ]
            assert [r["message"] for r in page2.get_json()] == [
                "Log 6",
                "Log 7",
                "Log 8",
            ]
            assert [r["message"] for r in page3.get_json()] == [
                "Log 3",
                "Log 4",
                "Log 5",
            ]
            assert [r["message"] for r in page4.get_json()] == [
                "Log 0",
                "Log 1",
                "Log 2",
            ]
        finally:
            self._close_session(session)

    def test_before_id_stable_under_concurrent_inserts(
        self, authenticated_client
    ):
        """The whole point of cursor pagination: rows that arrive after
        the cursor is captured don't shift the boundary. With offset
        they would; with before_id, the next page returns the same set
        of rows the caller would have seen without the inserts."""
        session = self._seed_real_session(10)
        try:
            # Page 1: ids 8, 9, 10 (messages Log 7, Log 8, Log 9).
            page1 = self._get_logs(
                authenticated_client, session, "?limit=3&before_id=0"
            )
            cursor1 = page1.get_json()[0]["id"]
            # Simulate 5 rows being inserted between the two calls
            # (e.g., a chat/research progress burst). With offset, the
            # next page would shift by 5. With before_id, the cursor
            # is still 8 and the response is the same: ids 5, 6, 7.
            from local_deep_research.database.models import ResearchLog

            base_time = session.query(ResearchLog).first().timestamp
            for i in range(5):
                session.add(
                    ResearchLog(
                        research_id="test-rid",
                        timestamp=base_time.replace(microsecond=0)
                        + timedelta(seconds=20 + i),
                        message=f"New {i}",
                        module="test",
                        function="test",
                        line_no=100 + i,
                        level="INFO",
                    )
                )
            session.commit()

            page2 = self._get_logs(
                authenticated_client,
                session,
                f"?limit=3&before_id={cursor1}",
            )
            # Same rows as if no inserts had happened: ids 5, 6, 7 (Log 4, 5, 6).
            assert [r["message"] for r in page2.get_json()] == [
                "Log 4",
                "Log 5",
                "Log 6",
            ]
        finally:
            self._close_session(session)

    def test_before_id_negative_clamps_to_zero(self, authenticated_client):
        """Defensive: a negative ``before_id`` is treated as 0 = newest
        window. The clamp sits at the SQL filter layer (the helper
        turns it into ``id < 0``, which matches no rows, so we floor
        to 0 instead)."""
        session = self._seed_real_session(10)
        try:
            clamped = self._get_logs(
                authenticated_client,
                session,
                "?limit=3&before_id=-1",
            )
            default = self._get_logs(authenticated_client, session, "?limit=3")
            assert clamped.status_code == 200
            assert clamped.get_json() == default.get_json()
        finally:
            self._close_session(session)

    # ------------------------------------------------------------------
    # ?after_id= cursor pagination — the symmetric forward cursor for
    # the non-live log panel's "Load newer" button. Same id-stability
    # guarantee as before_id (new rows have higher ids and don't shift
    # the cursor) and uses an index seek instead of a row-skip.
    # ------------------------------------------------------------------

    def test_after_id_returns_strictly_newer_rows(self, authenticated_client):
        """``?limit=N&after_id=X`` returns the next N rows strictly
        newer than id X, oldest-first (so the response ordering is
        contiguous with what the client already has)."""
        session = self._seed_real_session(10)
        try:
            # Rows have ids 1..10. Querying rows newer than id=5
            # returns ids 6..10, oldest-first.
            newer = self._get_logs(
                authenticated_client, session, "?limit=10&after_id=5"
            )
            assert [r["message"] for r in newer.get_json()] == [
                f"Log {i}" for i in range(5, 10)
            ]
            # Querying rows newer than the max id returns [].
            past_max = self._get_logs(
                authenticated_client, session, "?limit=5&after_id=10"
            )
            assert past_max.get_json() == []
        finally:
            self._close_session(session)

    def test_after_id_negative_clamps_to_zero(self, authenticated_client):
        """Defensive: a negative ``after_id`` is treated as 0 — the
        SQL filter becomes ``id > 0`` which matches every row, so a
        negative value is equivalent to omitting the cursor."""
        session = self._seed_real_session(10)
        try:
            clamped = self._get_logs(
                authenticated_client,
                session,
                "?limit=5&after_id=-1",
            )
            default = self._get_logs(authenticated_client, session, "?limit=5")
            assert clamped.status_code == 200
            assert clamped.get_json() == default.get_json()
        finally:
            self._close_session(session)

    def test_after_id_and_before_id_are_mutually_exclusive(
        self, authenticated_client
    ):
        """The two cursors can't be combined — the SQL planner can't
        combine two index seeks into a single ordered slice. Reject
        with 400 so the client falls back to one cursor at a time."""
        session = self._seed_real_session(10)
        try:
            response = self._get_logs(
                authenticated_client,
                session,
                "?limit=5&before_id=5&after_id=5",
            )
            assert response.status_code == 400
            assert "mutually exclusive" in response.get_json()["error"]
        finally:
            self._close_session(session)

    def test_after_id_walks_forward_past_history_logs_hard_cap(
        self, authenticated_client
    ):
        """Forward-walk through 12 rows of a paginated load using ``after_id``.

        The hard cap is patched to 3 so each page carries exactly 3 rows.
        ``after_id`` skips ids <= the cursor, so picking ``after_id=3``
        first yields ids 4-6 (oldest window after the boundary), then
        ``after_id=6`` yields 7-9, and ``after_id=9`` yields 10-12. Going
        past the last id returns ``[]`` — the endpoint correctly empties
        when the cursor is at the boundary.

        Note: ``after_id=0`` would NOT yield ids 1-3 because the endpoint
        coerces ``<= 0`` to ``None`` ("no cursor") and returns the newest
        ``limit`` rows — see ``test_after_id_negative_clamps_to_zero``.
        That's symmetrical to ``before_id=0`` returning the newest 3 in
        ``test_before_id_walks_past_history_logs_hard_cap``."""
        session = self._seed_real_session(12)
        try:
            with patch(f"{_RR}.HISTORY_LOGS_HARD_CAP", 3):
                # Rows have ids 1..12. Walk forward — first page starts
                # strictly past id 3 to land on ids 4, 5, 6.
                # Page 1: after_id=3 → ids 4,5,6 (Log 3,4,5).
                page1 = self._get_logs(
                    authenticated_client, session, "?limit=3&after_id=3"
                )
                page1_data = page1.get_json()
                assert [r["message"] for r in page1_data] == [
                    "Log 3",
                    "Log 4",
                    "Log 5",
                ], f"page1 unexpected: {page1_data}"
                # The newest id in page1 becomes the next cursor.
                cursor1 = page1_data[-1]["id"]
                assert cursor1 == 6

                page2 = self._get_logs(
                    authenticated_client,
                    session,
                    f"?limit=3&after_id={cursor1}",
                )
                page2_data = page2.get_json()
                assert [r["message"] for r in page2_data] == [
                    "Log 6",
                    "Log 7",
                    "Log 8",
                ], f"page2 unexpected: {page2_data}"
                cursor2 = page2_data[-1]["id"]
                assert cursor2 == 9

                page3 = self._get_logs(
                    authenticated_client,
                    session,
                    f"?limit=3&after_id={cursor2}",
                )
                page3_data = page3.get_json()
                assert [r["message"] for r in page3_data] == [
                    "Log 9",
                    "Log 10",
                    "Log 11",
                ], f"page3 unexpected: {page3_data}"

                # One step further past the last id returns an empty
                # batch — the cursor-based pagination contract, ready
                # for the frontend to pin ``newestLoadedId`` and hide
                # the Load newer button.
                cursor3 = page3_data[-1]["id"]
                page4 = self._get_logs(
                    authenticated_client,
                    session,
                    f"?limit=3&after_id={cursor3}",
                )
                assert page4.get_json() == []
        finally:
            self._close_session(session)


class TestGetResearchLogsAllApi:
    """Tests for the priority-free ``/api/research/<id>/logs/all`` endpoint.

    This endpoint exists so the non-live (completed-research) log panel
    can fetch its rows without going through the ``?priority=diagnostic``
    triage logic that lives on the original ``/api/research/<id>/logs``
    endpoint. Live (running) panels keep using the priority endpoint;
    only results-page / chat-with-completed-research panels use this one.

    The wire shape is identical to ``get_research_logs`` (a top-level JSON
    array of ``{id, message, timestamp, log_type}``), so a caller can
    swap between the two without other changes.
    """

    def test_requires_authentication(self, client):
        """Should require authentication, like the priority endpoint."""
        response = client.get(
            f"{RESEARCH_PREFIX}/api/research/test-id/logs/all"
        )
        # The Flask-Login wrapper returns 401 for unauthenticated API
        # requests (matches the priority endpoint's contract; we just
        # assert that auth is required, not the specific code).
        assert response.status_code in (302, 401), response.status_code

    def test_no_limit_returns_all_logs_oldest_first(self, authenticated_client):
        """The plain endpoint returns every row, oldest-first, with no triage."""
        session = TestGetResearchLogsApi._seed_real_session(10)
        try:
            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                response = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all"
                )
            assert response.status_code == 200, response.status_code
            messages = [r["message"] for r in response.get_json()]
            assert messages == [f"Log {i}" for i in range(10)]
        finally:
            TestGetResearchLogsApi._close_session(session)

    def test_limit_returns_newest_n_oldest_first(self, authenticated_client):
        """?limit=N takes the newest N rows without any diagnostic prioritization."""
        session = TestGetResearchLogsApi._seed_real_session(10)
        try:
            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                response = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all?limit=3"
                )
            assert response.status_code == 200, response.status_code
            messages = [r["message"] for r in response.get_json()]
            assert messages == ["Log 7", "Log 8", "Log 9"]
        finally:
            TestGetResearchLogsApi._close_session(session)

    def test_diagnostic_levels_do_not_bias_result_order(
        self, authenticated_client
    ):
        """The priority-free endpoint ignores WARNING / ERROR rows when
        picking the window — the panel for a completed research should
        see actual newest rows plain, not a triage list. This is the
        endpoint's whole reason to exist.
        """
        from local_deep_research.database.models import ResearchLog

        session = TestGetResearchLogsApi._seed_real_session(10)
        try:
            rows = session.query(ResearchLog).order_by(ResearchLog.id).all()
            # Promote the oldest two rows to WARNING/ERROR. On the
            # priority endpoint these would be surfaced into the
            # 3-row window; on the priority-free endpoint they stay
            # out because they're older than ``limit=2`` newest rows.
            rows[0].level = "WARNING"
            rows[1].level = "ERROR"
            session.commit()

            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                response = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all?limit=2"
                )
            assert response.status_code == 200, response.status_code
            messages = [r["message"] for r in response.get_json()]
            # The two newest (newest ids 10, 9) come back; the
            # diagnostics at ids 1, 2 are NOT promoted into the window
            # the way they would be on the priority endpoint.
            assert messages == ["Log 8", "Log 9"]
        finally:
            TestGetResearchLogsApi._close_session(session)

    def test_before_id_returns_strictly_older_rows(self, authenticated_client):
        """Symmetric cursor contract on the priority-free endpoint."""
        session = TestGetResearchLogsApi._seed_real_session(10)
        try:
            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                response = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all?before_id=5"
                )
            assert response.status_code == 200, response.status_code
            messages = [r["message"] for r in response.get_json()]
            assert messages == ["Log 0", "Log 1", "Log 2", "Log 3"]
        finally:
            TestGetResearchLogsApi._close_session(session)

    def test_after_id_returns_strictly_newer_rows(self, authenticated_client):
        """Symmetric forward cursor on the priority-free endpoint."""
        session = TestGetResearchLogsApi._seed_real_session(10)
        try:
            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                response = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all?after_id=7"
                )
            assert response.status_code == 200, response.status_code
            messages = [r["message"] for r in response.get_json()]
            # Rows have ids 1..10 (Log 0..Log 9). after_id=7 returns
            # rows where id > 7 — ids 8, 9, 10 → messages Log 7, 8, 9.
            assert messages == ["Log 7", "Log 8", "Log 9"]
        finally:
            TestGetResearchLogsApi._close_session(session)

    def test_before_id_and_after_id_are_mutually_exclusive(
        self, authenticated_client
    ):
        """Sending both cursors must return 400 — same planner
        limitation that applies to the priority endpoint."""
        session = TestGetResearchLogsApi._seed_real_session(10)
        try:
            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                response = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/all"
                    "?before_id=5&after_id=7"
                )
            assert response.status_code == 400, response.status_code
            payload = response.get_json()
            assert "error" in payload
            assert "before_id and after_id" in payload["error"]
        finally:
            TestGetResearchLogsApi._close_session(session)

    def test_404_for_missing_research(self, authenticated_client):
        """Same 404 contract as the priority endpoint."""
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_session = MagicMock()
            mock_session.query.return_value.filter_by.return_value.first.return_value = None
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/research/missing-rid/logs/all"
            )
        assert response.status_code == 404, response.status_code


class TestExportResearchLogsApi:
    """Tests for /api/research/<id>/logs/export streaming endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(
            f"{RESEARCH_PREFIX}/api/research/test-id/logs/export"
        )
        assert response.status_code == 401, response.status_code

    @staticmethod
    def _build_engine_with_seed(num_logs, rid="test-rid"):
        """Build an in-memory SQLite engine, create the schema, seed one
        research + ``num_logs`` log rows, and return ``(engine, session)``
        bound to that engine. Returning the engine (not just the session)
        lets the test ``.dispose()`` it to release the underlying
        sqlite connection — otherwise pytest reports a ResourceWarning.

        ``export_research_logs`` opens ``get_user_db_session`` *twice*
        (existence check + streaming generator). Both calls must see the
        same committed rows, so the test patches the factory to hand out
        a single shared session against this engine rather than building
        two separate in-memory DBs.
        """
        from datetime import datetime, timedelta, timezone

        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from local_deep_research.database.models import (
            Base,
            ResearchHistory,
            ResearchLog,
        )

        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        session = sessionmaker(bind=engine)()

        session.add(
            ResearchHistory(
                id=rid,
                query="q",
                mode="quick",
                status="completed",
                created_at="2025-01-01T00:00:00+00:00",
            )
        )
        base_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
        for i in range(num_logs):
            session.add(
                ResearchLog(
                    research_id=rid,
                    timestamp=base_time + timedelta(minutes=i),
                    message=f"Log {i}",
                    module="test",
                    function="test",
                    line_no=i,
                    level="INFO",
                )
            )
        session.commit()
        return engine, session

    @staticmethod
    def _patch_session(session):
        """Patch ``get_user_db_session`` so every call returns a context
        manager yielding the same ``session``. ``export_research_logs``
        calls the factory twice (existence check + streaming); reusing one
        session keeps the in-memory DB contract simple.
        """
        cm = MagicMock()
        cm.__enter__ = lambda self: session
        cm.__exit__ = MagicMock(return_value=False)
        return patch(f"{_RR}.get_user_db_session", return_value=cm)

    @staticmethod
    def _teardown(engine, session):
        """Close the session AND dispose the engine so the underlying
        sqlite connection is released; otherwise pytest reports a
        ResourceWarning."""
        session.close()
        engine.dispose()

    def test_returns_404_when_research_missing(self, authenticated_client):
        """A non-existent research must short-circuit before any streaming
        session is opened — otherwise the user pays for a generator that
        always emits zero rows."""
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from local_deep_research.database.models import Base

        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        empty_session = sessionmaker(bind=engine)()

        try:
            with self._patch_session(empty_session):
                resp = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/export"
                )
            assert resp.status_code == 404, resp.status_code
            assert resp.get_json()["error"] == "Research not found"
        finally:
            empty_session.close()
            engine.dispose()

    def test_streams_all_logs_as_ndjson(self, authenticated_client):
        """Every persisted row must appear in the response body, oldest
        first, one JSON object per line.
        """
        import json

        num_logs = 7  # multiple log rows to verify streaming NDJSON structure
        engine, seed = self._build_engine_with_seed(num_logs)
        try:
            with self._patch_session(seed):
                resp = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/export"
                )

            assert resp.status_code == 200, resp.status_code
            # NDJSON is one JSON object per line, terminated by '\n'.
            # The last line is allowed to lack a trailing newline depending
            # on the writer, so rstrip is required before splitting.
            lines = resp.get_data(as_text=True).rstrip("\n").split("\n")
            assert len(lines) == num_logs, len(lines)

            parsed = [json.loads(line) for line in lines]
            messages = [entry["message"] for entry in parsed]
            assert messages == [f"Log {i}" for i in range(num_logs)]
            # Oldest-first: Log 0 precedes Log N-1.
            assert messages[0] == "Log 0"
            assert messages[-1] == f"Log {num_logs - 1}"

            # All required fields (including log_type aligned with /logs) are present on every row.
            for entry in parsed:
                assert set(entry.keys()) == {
                    "id",
                    "timestamp",
                    "message",
                    "level",
                    "log_type",
                    "module",
                    "line_no",
                }
        finally:
            self._teardown(engine, seed)

    def test_response_is_streamed(self, authenticated_client):
        """``Response.is_streamed`` must be true so Flask returns the
        generator to the WSGI server as an iterator rather than
        materialising it. This is the property that makes the export
        memory-bounded on the server."""
        engine, seed = self._build_engine_with_seed(3)
        try:
            with self._patch_session(seed):
                resp = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/export"
                )
            assert resp.status_code == 200, resp.status_code
            assert resp.is_streamed is True, resp.is_streamed
            assert resp.headers["Content-Disposition"].startswith(
                "attachment; filename="
            )
            assert resp.headers["Content-Disposition"].endswith('.jsonl"')
            assert resp.mimetype == "application/x-ndjson"
        finally:
            self._teardown(engine, seed)

    def test_zero_logs_returns_empty_body(self, authenticated_client):
        """A research with zero logs is a valid state (e.g. still running).
        The endpoint must return 200 + an empty body rather than erroring
        on the empty generator — otherwise users would see a 500 for a
        perfectly normal research."""
        engine, seed = self._build_engine_with_seed(0)
        try:
            with self._patch_session(seed):
                resp = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/logs/export"
                )
            assert resp.status_code == 200, resp.status_code
            assert resp.get_data() == b""
        finally:
            self._teardown(engine, seed)

    def test_filename_sanitization_prevents_header_breakout(
        self, authenticated_client
    ):
        """Research IDs containing quotes or special characters must have those
        stripped in Content-Disposition header so header breakout is impossible.
        """
        engine, seed = self._build_engine_with_seed(0, rid='test-rid"extra')
        try:
            with self._patch_session(seed):
                resp = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid%22extra/logs/export"
                )
            assert resp.status_code == 200, resp.status_code
            cd = resp.headers["Content-Disposition"]
            assert 'filename="research_logs_test-ridextra.jsonl"' in cd
        finally:
            self._teardown(engine, seed)


class TestGetResearchStatusApi:
    """Tests for /api/research/<id>/status endpoint."""

    def test_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/api/research/test-id/status")
        assert response.status_code == 401, response.status_code

    def test_returns_status_when_authenticated(self, authenticated_client):
        """Should return research status when authenticated."""
        mock_session = MagicMock()
        mock_session.query.return_value.filter_by.return_value.first.return_value = None
        with patch(f"{_RR}.get_user_db_session") as mock_db:
            mock_db.return_value.__enter__ = lambda s: mock_session
            mock_db.return_value.__exit__ = MagicMock(return_value=False)
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/research/test-id/status"
            )
            assert response.status_code == 404, response.status_code

    def test_latest_milestone_tie_breaks_equal_timestamps_by_id(
        self, authenticated_client
    ):
        """The /status latest-milestone ``.first()`` picks the highest-id
        milestone among rows sharing the latest timestamp — deterministic,
        not the SQL-undefined arbitrary row the prior single-key order_by
        allowed. Driven through real SQL so the ``id`` tie-break is exercised
        (a mocked ``.first()`` would ignore the order_by and pass regardless).
        """
        from datetime import datetime, timezone

        from local_deep_research.database.models import ResearchLog

        # Reuse the real-session seeding (research row, no INFO logs), then add
        # 3 MILESTONE rows sharing one timestamp; ids rise with insertion so
        # "Milestone 2" is the highest-id (most recently inserted) one.
        session = TestGetResearchLogsApi._seed_real_session(0)
        shared_time = datetime(2025, 1, 1, tzinfo=timezone.utc)
        for i in range(3):
            session.add(
                ResearchLog(
                    research_id="test-rid",
                    timestamp=shared_time,
                    message=f"Milestone {i}",
                    module="test",
                    function="test",
                    line_no=i,
                    level="MILESTONE",
                )
            )
        session.commit()
        try:
            with patch(f"{_RR}.get_user_db_session") as mock_db:
                mock_db.return_value.__enter__ = lambda s: session
                mock_db.return_value.__exit__ = MagicMock(return_value=False)
                resp = authenticated_client.get(
                    f"{RESEARCH_PREFIX}/api/research/test-rid/status"
                )
            assert resp.status_code == 200, resp.status_code
            assert resp.get_json()["log_entry"]["message"] == "Milestone 2"
        finally:
            TestGetResearchLogsApi._close_session(session)


class TestQueueStatusApi:
    """Tests for queue status API endpoints."""

    def test_get_queue_status_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/api/queue/status")
        assert response.status_code == 401, response.status_code

    def test_get_queue_status_when_authenticated(self, authenticated_client):
        """Should return queue status when authenticated."""
        with patch("local_deep_research.web.queue.QueueManager") as mock_qm:
            mock_qm.get_user_queue.return_value = []
            response = authenticated_client.get(
                f"{RESEARCH_PREFIX}/api/queue/status"
            )
            assert response.status_code == 200, response.status_code

    def test_get_queue_position_requires_authentication(self, client):
        """Should require authentication."""
        response = client.get(f"{RESEARCH_PREFIX}/api/queue/test-id/position")
        assert response.status_code == 401, response.status_code
