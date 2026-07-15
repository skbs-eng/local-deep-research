"""
Server runtime environment settings.

These settings control server-level parameters that require a restart
to take effect. They are not editable via the UI.
"""

from ..env_settings import IntegerSetting, StringSetting

SERVER_SETTINGS = [
    IntegerSetting(
        key="server.max_concurrent_research",
        description="Server-wide maximum concurrent research operations. Requires restart.",
        min_value=1,
        max_value=1000,
        default=10,
        deprecated_env_var="LDR_MAX_GLOBAL_CONCURRENT",
    ),
    # Registered as StringSetting (not IntegerSetting) because the
    # langgraph_agent_strategy clamps out-of-range integers with a warning
    # rather than raising — IntegerSetting's strict range validation
    # would mask that graceful behaviour and force a hard fallback to
    # the setting's default, hiding the user's misconfig from the logs.
    StringSetting(
        key="langgraph_agent.subagent_max_workers",
        description=(
            "Maximum parallel workers for the langgraph-agent "
            "research_subtopic fan-out, as an integer string. Tune up "
            "for ollama / lmstudio / llama.cpp deployments whose "
            "backend exposes its own parallel-request knob; lower it "
            "for single-stream local backends. Out-of-range / "
            "non-integer values are clamped with a warning to "
            "[1, MAX_SUBTOPICS=5] (the constant MAX_SUBTOPICS caps "
            "this regardless of the env value). Requires restart. (#5014)"
        ),
        default="",
    ),
]
