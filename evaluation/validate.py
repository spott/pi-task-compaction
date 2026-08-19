#!/usr/bin/env python3
"""Load and verify the checked-in M13 specifications with pi-experiment-harness."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

from pi_experiments.matrix import expand_variants
from pi_experiments.scenario import load_experiment, load_scenario

ROOT = Path(__file__).resolve().parent
EXPERIMENTS = ROOT / "experiments"
SCENARIOS = ROOT / "scenarios"
ENTRYPOINT = (ROOT.parent / "extensions" / "task-framework.ts").resolve()
PI_EXECUTABLE = (ROOT.parent / "node_modules" / ".bin" / "pi").resolve()
FEATURE_KEYS = (
    "task-framework-tasks",
    "task-framework-summaries",
    "task-framework-compaction",
    "task-framework-agents",
)

PRIMARY = {
    "vanilla": None,
    "tasks-only": (True, False, False, False),
    "tasks-summaries": (True, True, False, False),
    "tasks-summaries-compaction": (True, True, True, False),
    "tasks-summaries-agents": (True, True, False, True),
    "full": (True, True, True, True),
}
DIAGNOSTIC = {
    "diagnostic-noop-closure-summary": (True, False, False, False),
    "diagnostic-agents-without-summaries": (True, False, False, True),
    "diagnostic-tasks-summaries-agents-compaction-off": (True, True, False, True),
}


def configurations(path: Path) -> dict[str, dict[str, object]]:
    experiment = load_experiment(path)
    variants = expand_variants(experiment.matrix)
    result: dict[str, dict[str, object]] = {}
    for variant in variants:
        config = dict(variant.configuration)
        name = config.get("name")
        if not isinstance(name, str):
            raise AssertionError(f"{path}: configuration has no string name")
        if name in result:
            raise AssertionError(f"{path}: duplicate configuration {name}")
        result[name] = config
    return result


def feature_tuple(config: dict[str, object]) -> tuple[bool, bool, bool, bool]:
    flags = config.get("extension_flags")
    if not isinstance(flags, dict):
        raise AssertionError("task-framework configuration has no extension_flags mapping")
    values = tuple(flags.get(key) for key in FEATURE_KEYS)
    if not all(isinstance(value, bool) for value in values):
        raise AssertionError(f"feature flags must be explicit booleans: {values}")
    return values  # type: ignore[return-value]


def verify_matrix(path: Path, expected: dict[str, tuple[bool, bool, bool, bool] | None]) -> int:
    configs = configurations(path)
    if set(configs) != set(expected):
        raise AssertionError(f"{path}: expected {sorted(expected)}, got {sorted(configs)}")
    for name, features in expected.items():
        config = configs[name]
        if features is None:
            if config.get("extensions") != [] or "extension_flags" in config:
                raise AssertionError(f"{path}: vanilla must load no extension or framework flags")
        else:
            if feature_tuple(config) != features:
                raise AssertionError(f"{path}: {name} has feature tuple {feature_tuple(config)}, expected {features}")
            extensions = config.get("extensions")
            if extensions != [{"source": str(ENTRYPOINT)}]:
                raise AssertionError(f"{path}: {name} must load only {ENTRYPOINT}, got {extensions!r}")
    return len(configs)


def main() -> None:
    scenario_paths = sorted(SCENARIOS.glob("*.yaml"))
    experiment_paths = sorted(EXPERIMENTS.glob("*.yaml"))
    for path in scenario_paths:
        load_scenario(path)
    for path in experiment_paths:
        experiment = load_experiment(path)
        load_scenario(experiment.scenario_path)
        expand_variants(experiment.matrix)
        if Path(experiment.run.pi_executable).resolve() != PI_EXECUTABLE or not PI_EXECUTABLE.is_file():
            raise AssertionError(f"{path}: pi_executable must resolve to checked-out Pi binary {PI_EXECUTABLE}")

    primary_count = verify_matrix(EXPERIMENTS / "primary.yaml", PRIMARY)
    diagnostic_count = verify_matrix(EXPERIMENTS / "diagnostic.yaml", DIAGNOSTIC)

    continuity = [path for path in experiment_paths if path.name.startswith("continuity-")]
    for path in continuity:
        configs = configurations(path)
        if set(configs) != {"full"} or feature_tuple(configs["full"]) != (True, True, True, True):
            raise AssertionError(f"{path}: continuity workload must use exactly one full-framework configuration")

    manifest = yaml.safe_load((ROOT / "workloads.yaml").read_text(encoding="utf-8"))
    records = manifest.get("workloads") if isinstance(manifest, dict) else None
    if not isinstance(records, list):
        raise AssertionError("workloads.yaml must contain a workloads list")
    for record in records:
        if not isinstance(record, dict):
            raise AssertionError("workload records must be mappings")
        for field in ("experiment", "scenario"):
            reference = record.get(field)
            if not isinstance(reference, str) or not (ROOT / reference).is_file():
                raise AssertionError(f"workload {record.get('id')}: invalid {field} reference {reference!r}")

    print(
        json.dumps(
            {
                "scenarios": len(scenario_paths),
                "experiments": len(experiment_paths),
                "primary_arms": primary_count,
                "diagnostic_arms": diagnostic_count,
                "continuity_workloads": len(continuity),
                "manifest_records": len(records),
                "status": "ok",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
