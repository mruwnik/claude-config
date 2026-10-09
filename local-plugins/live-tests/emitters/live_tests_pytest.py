"""pytest plugin emitting live-tests `@@test` events (loaded with -p live_tests_pytest)."""

import json
import os

import pytest

# Duplicated at import, before pytest's fd capture swaps fd 1 out from under us.
_OUT = os.fdopen(os.dup(1), "w", buffering=1)

# The run's nonce marks its own events, so test output cannot pass for one.
_MARK = "@@test:" + os.environ["LIVE_TESTS_NONCE"] if os.environ.get("LIVE_TESTS_NONCE") else "@@test"


def emit(**event):
    _OUT.write(_MARK + " " + json.dumps(event) + "\n")


def pytest_collection_finish(session):
    emit(event="plan", total=len(session.items))


_planned = False


# Under xdist the controller never collects, so the total comes from the workers, which all collect the same set.
@pytest.hookimpl(optionalhook=True)
def pytest_xdist_node_collection_finished(node, ids):
    global _planned
    if _planned:
        return
    _planned = True
    emit(event="plan", total=len(ids))


def outcome_of(report):
    if report.skipped:
        return "skipped"
    if report.failed:
        return "failed" if report.when == "call" else "error"
    return "passed"


def pytest_runtest_logreport(report):
    is_final = report.when == "call" or report.failed or (report.when == "setup" and report.skipped)
    if not is_final:
        return
    outcome = outcome_of(report)
    message = report.longreprtext if outcome in ("failed", "error") else None
    emit(event="result", name=report.nodeid, outcome=outcome, message=message)


def pytest_collectreport(report):
    if not report.failed:
        return
    emit(event="result", name=report.nodeid or "<collection>", outcome="error", message=report.longreprtext)
