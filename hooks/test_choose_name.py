import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).with_name("choose_name.py")


def run_script(home: Path, *args: str, stdin: str = "") -> str:
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        input=stdin, capture_output=True, text=True, check=True,
        env={**os.environ, "HOME": str(home), "CHOOSE_NAME_NO_WRITER": "1"},
    ).stdout


def run_hook(home: Path, **hook_input) -> dict:
    hook_input = {"session_id": "abc", "hook_event_name": "SessionStart", "cwd": "/x/koseki", **hook_input}
    return json.loads(run_script(home, stdin=json.dumps(hook_input)))["hookSpecificOutput"]


@pytest.mark.parametrize("source", ["startup", "resume", "fork"])
def test_untitled_session_gets_name_with_project(tmp_path, source):
    out = run_hook(tmp_path, source=source)

    assert out["sessionTitle"].endswith("-koseki")
    assert out["sessionTitle"] in out["additionalContext"]


@pytest.mark.parametrize("source", ["startup", "resume", "fork"])
def test_titled_session_keeps_its_name(tmp_path, source):
    out = run_hook(tmp_path, source=source, session_title="Paragon-conversations")

    assert "sessionTitle" not in out
    assert "Paragon-conversations" in out["additionalContext"]


def test_writer_sets_name_on_matching_session_file(tmp_path):
    sessions = tmp_path / ".claude" / "sessions"
    sessions.mkdir(parents=True)
    ours = {"pid": 1, "sessionId": "abc", "name": "koseki-8b", "status": "busy"}
    other = {"pid": 2, "sessionId": "zzz", "name": "raspberry-80"}
    (sessions / "1.json").write_text(json.dumps(ours))
    (sessions / "2.json").write_text(json.dumps(other))

    run_script(tmp_path, "--write-name", "abc", "Waxillium-koseki")

    assert json.loads((sessions / "1.json").read_text()) == {**ours, "name": "Waxillium-koseki"}
    assert json.loads((sessions / "2.json").read_text()) == other
