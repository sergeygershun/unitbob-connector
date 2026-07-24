// The connector-owned pytest-bdd reporter (spec 32). Python has no Cucumber
// Messages emitter, so the connector ships this small deterministic plugin. It
// hangs off pytest-bdd's public scenario/step hooks and writes one JSON document
// the Rails PytestBddJson parser reads:
//
//   { "version": 1, "scenarios": [ { name, tags, status, failure, steps: [...] } ] }
//
// It only records — it never reconciles markers or aggregates capabilities. It
// is connector-owned and never part of the LLM-generated step definitions.
export const PYTEST_BDD_PLUGIN = `# Written by the unitbob connector — do not edit.
import json
import os

_UNITBOB_REPORT = {"version": 1, "scenarios": []}
_UNITBOB_CURRENT = {}


def pytest_bdd_before_scenario(request, feature, scenario):
    _UNITBOB_CURRENT[id(scenario)] = {
        "name": scenario.name,
        "tags": sorted(scenario.tags),
        "status": "passed",
        "failure": "",
        "steps": [],
    }


def _record_step(scenario, step, status):
    entry = _UNITBOB_CURRENT.get(id(scenario))
    if entry is None:
        return
    entry["steps"].append({
        "keyword": getattr(step, "keyword", "").strip(),
        "text": step.name,
        "status": status,
    })


def pytest_bdd_after_step(request, feature, scenario, step, step_func):
    _record_step(scenario, step, "passed")


def pytest_bdd_step_error(request, feature, scenario, step, step_func, step_func_args, exception):
    entry = _UNITBOB_CURRENT.get(id(scenario))
    if entry is not None:
        entry["status"] = "failed"
        entry["failure"] = "{}: {}".format(type(exception).__name__, exception)
    _record_step(scenario, step, "failed")


def pytest_bdd_after_scenario(request, feature, scenario):
    entry = _UNITBOB_CURRENT.pop(id(scenario), None)
    if entry is not None:
        _UNITBOB_REPORT["scenarios"].append(entry)


def pytest_sessionfinish(session, exitstatus):
    out = os.environ.get("UNITBOB_PYTEST_BDD_REPORT")
    if out:
        with open(out, "w") as handle:
            json.dump(_UNITBOB_REPORT, handle)
`;
