#!/usr/bin/env python3
"""Evidence-branch runner; never imported by the OpenClaw product."""

import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import sys
import threading
import time


ROOT = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
PROOF = Path(os.environ["P05_PROOF_ROOT"]).resolve()
PUBLIC = PROOF / "public"
PRIVATE = PROOF / "private"
WORKFLOW_PATH = ".github/workflows/p05-receipt-proof.yml"
RUNNER_PATH = ".github/workflows/p05-receipt-proof.py"
COMPUTER_TEST = "src/agents/tools/computer-tool.effect-receipt.test.ts"
PRIVATE_TEST = "src/agents/tool-effect-receipt.test.ts"
PROOF_SCRIPT = "scripts/dev/computer-use-effect-receipt-proof.ts"
CHANGED_FILES = [
    "config/knip.config.ts",
    "docs/nodes/computer-use.md",
    PROOF_SCRIPT,
    "src/agents/tool-effect-receipt.ts",
    PRIVATE_TEST,
    "src/agents/tools/computer-tool.ts",
    COMPUTER_TEST,
]
SIBLINGS = [
    "src/agents/tool-terminal-outcome.test.ts",
    "src/agents/tool-result-error.test.ts",
    "packages/agent-core/src/agent-loop.test.ts",
    "src/agents/tools/computer-tool.test.ts",
    "src/agents/tools/computer-tool.observation.test.ts",
    "src/agents/tools/computer-tool.gateway.test.ts",
    "src/agents/tools/computer-tool-result.test.ts",
    "src/agents/tools/computer-tool.node-resolution.test.ts",
    "src/agents/tools/computer-tool.schema.test.ts",
]
BASE_RED_NAME = (
    "computer effect receipt after targeted observation retains unverifiable action evidence"
)
RIG = "scripts/dev/computer-use-macos-live-rig.sh"
TITLE = "OpenClaw Receipt Fixture"
SENTINEL = "OpenClaw Receipt Sentinel"


class ProofFailure(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise ProofFailure(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def git(*args, cwd=ROOT):
    return subprocess.check_output(
        ["git", "-c", "core.hooksPath=/dev/null", *args],
        cwd=cwd,
        stderr=subprocess.DEVNULL,
    ).decode().strip()


def current_head(cwd):
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"], cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def sanitize(value):
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", str(value))
    for directory, label in ((str(PRIVATE), "$PRIVATE"), (str(PROOF), "$PROOF"), (str(ROOT), "$SOURCE")):
        text = text.replace(directory, label)
    text = re.sub(r"https?://[^\s<>\"']+|wss?://[^\s<>\"']+", "[url]", text)
    text = re.sub(r"\b(?:\d{1,3}\.){3}\d{1,3}\b|(?<!\w)::1(?!\w)", "[ip]", text)
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", text)
    text = re.sub(r"(?<!\w)(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?!\w)", "[phone]", text)
    text = re.sub(r"(?<!\w)\+\d(?:[ ()-]*\d){7,14}(?!\w)", "[phone]", text)
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+)\b", "[credential]", text)
    text = re.sub(r"(?i)(bearer\s+|(?:token|password|api[-_]?key)\s*[=:]\s*)[^\s,;]+", r"\1[redacted]", text)
    # Rig tokens are 32 random bytes. Exact public hashes live in structured receipts,
    # not in this free-form command-output channel.
    return re.sub(r"\b[0-9a-fA-F]{64}\b", "[digest-or-token]", text)


def emit(name, value):
    require(re.fullmatch(r"[a-z0-9-]+", name), "invalid_receipt_name")
    text = json.dumps(value, indent=2) + "\n"
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / f"{name}.json").write_text(text, encoding="utf-8")
    print(text, flush=True)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
        output.write(f"\n### {name}\n\n~~~json\n{text}~~~\n")


def terminate_owned(process):
    """Stop the fresh owned group, join its leader, and observe group removal."""
    for sig, budget in ((signal.SIGTERM, 20), (signal.SIGKILL, 10)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=budget)
        except subprocess.TimeoutExpired:
            continue
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.1)
    return False


def run_command(label, command, cwd=ROOT, env=None, capture=False):
    started = time.monotonic()
    chunks = []
    captured_bytes = 0
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        start_new_session=True,
    )
    code = None
    try:
        with (PUBLIC / f"{label}.log").open("w", encoding="utf-8") as log:
            for line in process.stdout:
                safe = sanitize(line)
                log.write(safe)
                log.flush()
                print(safe, end="", flush=True)
                if capture:
                    captured_bytes += len(line.encode("utf-8"))
                    require(captured_bytes <= 32 * 1024 * 1024, "report_capture_limit_exceeded")
                    chunks.append(line)
        code = process.wait()
        return code, "".join(chunks)
    finally:
        group_empty = terminate_owned(process)
        emit(
            label + "-command",
            {
                "command": [sanitize(part) for part in command],
                "source_sha": current_head(cwd),
                "exit_code": code,
                "owned_group_observed_empty": group_empty,
                "duration_seconds": round(time.monotonic() - started, 3),
                "output": "redacted before persistence and console publication",
            },
        )
        require(group_empty, label + "_owned_process_cleanup_incomplete")


def checked(label, command, cwd=ROOT, env=None):
    code, _ = run_command(label, command, cwd=cwd, env=env)
    require(code == 0, label + "_failed")


def source_integrity():
    require(git("rev-parse", "HEAD") == os.environ["SOURCE_SHA"], "candidate_head_changed")
    require(git("rev-parse", "HEAD^{tree}") == os.environ["EXPECTED_SOURCE_TREE"], "candidate_tree_changed")
    require(not git("diff", "--name-only"), "tracked_source_changed")
    require(not git("diff", "--cached", "--name-only"), "tracked_index_changed")
    overlays = []
    path = ROOT / WORKFLOW_PATH
    if path.exists():
        require(not git("ls-files", "--", WORKFLOW_PATH), "unexpected_product_workflow")
        expected = (PROOF / "workflow.yml").read_bytes()
        require(path.read_bytes() == expected, "workflow_overlay_changed")
        overlays.append({"path": WORKFLOW_PATH, "sha256": digest(expected), "tracked": False})
    emit(
        "source-integrity",
        {
            "source_sha": os.environ["SOURCE_SHA"],
            "source_tree": os.environ["EXPECTED_SOURCE_TREE"],
            "tracked_source_unchanged": True,
            "disclosed_workflow_overlay": overlays,
            "runtime_source_overlay": False,
        },
    )


def built_snapshot():
    dist = ROOT / "dist"
    required = [
        "dist/.buildstamp", "dist/.runtime-postbuildstamp", "dist/entry.js",
        "dist/extensions/cua-computer/package.json",
    ]
    for name in required:
        require((ROOT / name).is_file(), "required_built_artifact_missing")
    stamps = {}
    for name in required[:2]:
        value = json.loads((ROOT / name).read_text())
        require(value.get("head") == os.environ["SOURCE_SHA"], "built_stamp_head_mismatch")
        require(value.get("inputsClean") is True, "built_stamp_inputs_not_clean")
        stamps[name] = {"head": value["head"], "inputsClean": value["inputsClean"]}
    files = {
        str(path.relative_to(ROOT)): digest(path.read_bytes())
        for path in sorted(dist.rglob("*")) if path.is_file() and not path.is_symlink()
    }
    links = {
        str(path.relative_to(ROOT)): digest(os.readlink(path).encode())
        for path in sorted(dist.rglob("*")) if path.is_symlink()
    }
    extension_files = {name: sha for name, sha in files.items() if name.startswith("dist/extensions/cua-computer/")}
    require(any(name.endswith((".js", ".mjs", ".cjs")) for name in extension_files), "built_cua_entry_missing")
    return {
        "source_sha": os.environ["SOURCE_SHA"], "source_tree": os.environ["EXPECTED_SOURCE_TREE"],
        "stamps": stamps, "dist_file_count": len(files),
        "dist_manifest_sha256": digest(json.dumps(files, sort_keys=True).encode()),
        "dist_symlink_count": len(links),
        "dist_symlink_manifest_sha256": digest(json.dumps(links, sort_keys=True).encode()),
        "entry_and_stamp_sha256": {name: files[name] for name in required},
        "cua_extension_file_count": len(extension_files),
        "cua_extension_manifest_sha256": digest(json.dumps(extension_files, sort_keys=True).encode()),
    }


def built_identity(verify=False):
    observed = built_snapshot()
    if verify:
        expected = json.loads((PUBLIC / "built-identity.json").read_text())
        require(observed == expected, "built_runtime_changed_after_build")
        emit("built-integrity", {**observed, "unchanged_after_native_rig": True})
    else:
        emit("built-identity", observed)


def identity():
    source_integrity()
    require(git("rev-parse", os.environ["BASE_SHA"] + "^{tree}") == os.environ["EXPECTED_BASE_TREE"], "base_tree_mismatch")
    changed = git("diff", "--name-only", "--no-renames", os.environ["BASE_SHA"], "HEAD").splitlines()
    require(sorted(changed) == sorted(CHANGED_FILES), "unexpected_candidate_delta")
    files = sorted(set(CHANGED_FILES + SIBLINGS))
    for name in files:
        require((ROOT / name).is_file(), "selected_file_missing")
        require(git("ls-files", "--", name) == name, "selected_file_not_tracked")
    workflow = (PROOF / "workflow.yml").read_bytes()
    runner = Path(__file__).read_bytes()
    require(
        subprocess.check_output(["git", "show", os.environ["WORKFLOW_SHA"] + ":" + WORKFLOW_PATH], cwd=ROOT) == workflow,
        "workflow_identity_mismatch",
    )
    require(
        subprocess.check_output(["git", "show", os.environ["WORKFLOW_SHA"] + ":" + RUNNER_PATH], cwd=ROOT) == runner,
        "runner_identity_mismatch",
    )
    emit(
        "source",
        {
            "source_repository": os.environ["SOURCE_REPOSITORY"],
            "source_sha": os.environ["SOURCE_SHA"],
            "source_tree": os.environ["EXPECTED_SOURCE_TREE"],
            "base_sha": os.environ["BASE_SHA"],
            "base_tree": os.environ["EXPECTED_BASE_TREE"],
            "workflow_sha": os.environ["WORKFLOW_SHA"],
            "workflow_sha256": digest(workflow),
            "runner_sha256": digest(runner),
            "lane": os.environ["P05_LANE"],
            "run_id": os.environ["GITHUB_RUN_ID"],
            "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
            "selected_source_sha256": {name: digest((ROOT / name).read_bytes()) for name in files},
            "boundaries": [
                "Canonical unit fixtures are synthetic transport proof.",
                "Native lane uses source-imported tool/terminal owners, built Gateway/node, and actual CUA.",
                "No agent/model/voice, physical-device, upgrade, or post-parent-landing qualification.",
                "No archives or artifact uploads; sanitized receipts are in this run's logs and summary.",
            ],
        },
    )


def reports_from_console(text):
    """Read native JSON reporter output in memory; persist only sanitized projections."""
    reports = []
    decoder = json.JSONDecoder()
    for match in re.finditer(r"(?m)^[ \t]*\{", text):
        try:
            value, _ = decoder.raw_decode(text[match.start():].lstrip())
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and {"testResults", "numTotalTests", "success"} <= value.keys():
            reports.append(value)
    require(reports, "native_test_report_missing")
    return reports


def run_tests(label, files, expected=None, cwd=ROOT, base_red=False):
    command = ["pnpm", "test", *files, "--maxWorkers=1", "--reporter=json"]
    if base_red:
        command += ["--testNamePattern", "^" + re.escape(BASE_RED_NAME) + "$"]
    code, text = run_command(label, command, cwd=cwd, capture=True)
    reports = reports_from_console(text)
    observed = []
    assertions = []
    for report in reports:
        require(report.get("numRuntimeErrorTestSuites", 0) == 0, "test_runtime_error")
        for result in report["testResults"]:
            name = str(Path(result["name"]).resolve().relative_to(cwd.resolve()))
            require(name in files, "unexpected_test_file")
            observed.append(name)
            assertions.extend((name, test) for test in result["assertionResults"])
    require(sorted(observed) == sorted(files), "test_file_inventory_mismatch")
    inventory = [
        {"file": name, "name": sanitize(test["fullName"]), "status": test["status"]}
        for name, test in assertions
    ]
    if base_red:
        selected = [(name, test) for name, test in assertions if test["fullName"] == BASE_RED_NAME]
        require(code == 1 and len(selected) == 1, "base_did_not_fail_one_selected_case")
        selected_name, failure = selected[0]
        messages = "\n".join(failure.get("failureMessages", []))
        require(selected_name == COMPUTER_TEST and failure["status"] == "failed", "wrong_base_failure")
        require(
            "AssertionError" in messages and "mutation_committed" in messages and "uncertain" in messages,
            "base_failure_not_the_receipt_assertion",
        )
        require(
            all(test is failure or test["status"] in ("pending", "skipped") for _, test in assertions),
            "unexpected_base_case_execution",
        )
        require(sum(report["numFailedTests"] for report in reports) == 1, "unexpected_base_failure_count")
        emit(
            "base-red-assertion",
            {
                "expected_failure_verified": True,
                "canonical_exit_code": code,
                "selected_test": BASE_RED_NAME,
                "failure": sanitize(messages),
                "expected_state": "uncertain",
                "actual_state": "mutation_committed",
                "filtered_case_count": len(assertions) - 1,
                "not_a_setup_or_import_failure": True,
            },
        )
    else:
        require(code == 0 and all(report["success"] is True for report in reports), "test_command_failed")
        require(assertions and all(test["status"] == "passed" for _, test in assertions), "test_case_not_passed")
        if expected is not None:
            require(len(assertions) == expected, "unexpected_case_count")
        emit(label + "-cases", {"passed": len(assertions), "failed": 0, "skipped": 0, "tests": inventory})


def base_red():
    base = PRIVATE / "base"
    require(not base.exists(), "base_checkout_already_exists")
    checked("base-init", ["git", "-c", "core.hooksPath=/dev/null", "init", str(base)])
    checked("base-remote", ["git", "remote", "add", "origin", "https://github.com/CompleteDotTech/openclaw.git"], cwd=base)
    checked("base-fetch", ["git", "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--depth=1", "origin", os.environ["BASE_SHA"]], cwd=base)
    checked("base-checkout", ["git", "-c", "core.hooksPath=/dev/null", "checkout", "--detach", os.environ["BASE_SHA"]], cwd=base)
    require(git("rev-parse", "HEAD", cwd=base) == os.environ["BASE_SHA"], "base_head_mismatch")
    require(git("rev-parse", "HEAD^{tree}", cwd=base) == os.environ["EXPECTED_BASE_TREE"], "base_tree_mismatch")
    checked("base-install", ["pnpm", "install", "--frozen-lockfile"], cwd=base)
    require(not git("diff", "--name-only", cwd=base), "base_install_changed_source")
    require(not git("ls-files", "--", COMPUTER_TEST, cwd=base), "base_already_has_regression")
    overlay = (ROOT / COMPUTER_TEST).read_bytes()
    destination = base / COMPUTER_TEST
    require(not destination.exists(), "base_overlay_destination_exists")
    destination.write_bytes(overlay)
    emit(
        "base-overlay",
        {
            "base_sha": os.environ["BASE_SHA"],
            "base_tree": os.environ["EXPECTED_BASE_TREE"],
            "candidate_sha": os.environ["SOURCE_SHA"],
            "overlay": COMPUTER_TEST,
            "overlay_sha256": digest(overlay),
            "overlay_tracked": False,
            "private_receipt_test_not_overlaid": True,
            "production_source_unchanged": True,
        },
    )
    try:
        run_tests("base-red", [COMPUTER_TEST], cwd=base, base_red=True)
    finally:
        require(not git("diff", "--name-only", cwd=base), "base_runtime_changed_source")
        require(not git("diff", "--cached", "--name-only", cwd=base), "base_runtime_changed_index")
        require(destination.read_bytes() == overlay, "base_regression_overlay_changed")


class OwnedProcess:
    def __init__(self, name, command, env, pass_fds=()):
        self.name = name
        self.command = [sanitize(part) for part in command]
        self.codes = set()
        self.process = subprocess.Popen(
            command, cwd=ROOT, env=env, pass_fds=pass_fds,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", start_new_session=True,
        )
        # Raw daemon output never reaches a file or console.
        self.reader = threading.Thread(target=self.read_codes, daemon=True)
        self.reader.start()

    def read_codes(self):
        for line in self.process.stdout:
            self.codes.update(re.findall(r"\b(?:COMPUTER|NODE|GATEWAY)_[A-Z0-9_]{2,64}\b", line))

    def stop(self):
        process = self.process
        empty = terminate_owned(process)
        self.reader.join(timeout=2)
        return {
            "process": self.name, "command": self.command,
            "leader_joined": process.poll() is not None,
            "group_observed_empty": empty, "exit_code": process.returncode,
            "diagnostic_codes": sorted(self.codes),
        }


def read_json_command(command, env, timeout=20):
    result = subprocess.run(
        command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, timeout=timeout,
    )
    if result.returncode:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def native_in_session():
    env = dict(os.environ)
    for name in (
        "OPENCLAW_GATEWAY_URL", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD",
        "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_PROFILE",
        "OPENCLAW_HOME", "OPENCLAW_AGENT_DIR", "WAYLAND_DISPLAY",
    ):
        env.pop(name, None)
    env.update(
        XDG_SESSION_TYPE="x11", NO_AT_BRIDGE="0", GDK_BACKEND="x11",
        OPENCLAW_LOG_LEVEL="silent",
    )
    # GTK introspection is installed for Ubuntu's system Python. Select only
    # python3 through this private shim; preserve the canonical Node/pnpm PATH.
    shim = PRIVATE / "fixture-bin"
    shim.mkdir()
    (shim / "python3").symlink_to("/usr/bin/python3")
    env["PATH"] = str(shim) + os.pathsep + env["PATH"]
    processes = []
    cleanup = []
    rig = PRIVATE / "rig"
    output = PUBLIC / "native-result"
    port = 29431
    try:
        read_fd, write_fd = os.pipe()
        desktop = OwnedProcess(
            "xvfb", ["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
            env, pass_fds=(write_fd,),
        )
        processes.append(desktop)
        os.close(write_fd)
        try:
            require(select.select([read_fd], [], [], 20)[0], "xvfb_start_timeout")
            display = os.read(read_fd, 32).decode().strip()
            require(display.isdigit(), "xvfb_display_missing")
        finally:
            os.close(read_fd)
        env["DISPLAY"] = ":" + display
        processes.append(OwnedProcess("openbox", ["openbox", "--sm-disable"], env))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            window_manager = subprocess.run(
                ["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            )
            if re.search(r"window id # 0x[1-9a-fA-F][0-9a-fA-F]*", window_manager.stdout):
                break
            time.sleep(0.2)
        else:
            raise ProofFailure("window_manager_start_timeout")
        # This private bus started before Xvfb selected DISPLAY. Pass only the
        # owned desktop variables to subsequently activated accessibility services.
        checked(
            "private-dbus-desktop-environment",
            ["dbus-update-activation-environment", "DISPLAY", "XDG_SESSION_TYPE", "NO_AT_BRIDGE", "GDK_BACKEND"],
            env=env,
        )
        checked("rig-prepare", ["bash", RIG, "prepare-linux", "p05-receipt-proof", str(port), str(rig)], env=env)
        gateway = OwnedProcess("gateway", ["bash", RIG, "gateway", str(rig)], env)
        processes.append(gateway)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            require(gateway.process.poll() is None, "gateway_exited_before_ready")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                time.sleep(0.5)
        else:
            raise ProofFailure("gateway_start_timeout")
        processes.append(OwnedProcess("node", ["bash", RIG, "node", str(rig)], env))
        cli_env = dict(
            env, OPENCLAW_CONFIG_PATH=str(rig / "gateway.json"),
            OPENCLAW_STATE_DIR=str(rig / "cli-state"),
            OPENCLAW_GATEWAY_PORT=str(port),
        )
        approved_request = None
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            status = None
            pairing = read_json_command(["bash", RIG, "nodes", str(rig)], env)
            if isinstance(pairing, dict):
                pending = pairing.get("pending", [])
                require(len(pending) <= 1, "unexpected_pairing_requests")
                if pending:
                    request = pending[0]
                    require(request.get("displayName") == "OpenClaw CUA X11 Live Proof", "unexpected_pairing_identity")
                    request_id = request.get("requestId")
                    require(isinstance(request_id, str) and request_id, "pairing_request_id_missing")
                    require(approved_request in (None, request_id), "pairing_requires_second_approval")
                    if approved_request is None:
                        approved_request = request_id
                        approval = read_json_command(["bash", RIG, "approve", str(rig), request_id], env)
                        if approval is None:
                            # Same-host auto-approval can remove the pending row
                            # before the CLI preflight. Verify that exact node;
                            # never retry approval or authorize another identity.
                            status = read_json_command(
                                ["node", "scripts/run-node.mjs", "nodes", "status", "--json"], cli_env,
                            )
                            ready = [
                                node for node in status.get("nodes", []) if node.get("connected")
                            ] if isinstance(status, dict) else []
                            require(
                                len(ready) == 1
                                and isinstance(request.get("nodeId"), str)
                                and ready[0].get("nodeId") == request["nodeId"]
                                and ready[0].get("computerUse", {}).get("provider", {}).get("id") == "cua-computer"
                                and {"computer.act", "screen.snapshot"} <= set(ready[0].get("commands", [])),
                                "node_command_approval_failed",
                            )
                        emit("node-approval", {
                            "explicit_attempts": 1,
                            "cli_returned_json": approval is not None,
                            "already_approved_exact_pending_node_verified": approval is None,
                        })
            if status is None:
                status = read_json_command(
                    ["node", "scripts/run-node.mjs", "nodes", "status", "--json"], cli_env,
                )
            nodes = status.get("nodes", []) if isinstance(status, dict) else []
            connected = [node for node in nodes if node.get("connected")]
            require(len(connected) <= 1, "unexpected_connected_node")
            if connected:
                node = connected[0]
                provider = node.get("computerUse", {}).get("provider", {}).get("id")
                if provider == "cua-computer" and {"computer.act", "screen.snapshot"} <= set(node.get("commands", [])):
                    break
            time.sleep(0.5)
        else:
            raise ProofFailure("paired_cua_node_start_timeout")
        processes.append(OwnedProcess(
            "fixture", ["bash", RIG, "fixture", str(rig), TITLE, SENTINEL, "P05 RECEIPT BEFORE"], env,
        ))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            active = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowname"], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            )
            if active.returncode == 0 and active.stdout.strip() == SENTINEL:
                break
            time.sleep(0.2)
        else:
            raise ProofFailure("fixture_start_timeout")
        proof_env = dict(
            env, OPENCLAW_CONFIG_PATH=str(rig / "gateway.json"),
            OPENCLAW_STATE_DIR=str(rig / "agent-state"),
            OPENCLAW_GATEWAY_PORT=str(port),
        )
        code, _ = run_command(
            "native-provider", ["node", "--import", "./scripts/tsx.mjs", PROOF_SCRIPT,
                                "--window-title", TITLE, "--artifacts", str(output)],
            env=proof_env,
        )
        report = json.loads((output / "result.json").read_text())
        # The committed proof script owns this explicitly allowlisted receipt.
        emit("native-provider-result", report)
        require(code == 0 and report["ok"] is True, "native_provider_assertion_failed")
        require(report["source"]["commit"] == os.environ["SOURCE_SHA"], "native_source_mismatch")
        require(report["source"]["tree"] == os.environ["EXPECTED_SOURCE_TREE"], "native_tree_mismatch")
        require(report["action"]["attempts"] == 1, "native_action_count_mismatch")
        require(report["receipt"]["privateState"] == "uncertain", "native_private_receipt_mismatch")
        require(report["receipt"]["terminalState"] == "uncertain", "native_terminal_receipt_mismatch")
    finally:
        for process in reversed(processes):
            cleanup.append(process.stop())
        emit("native-process-cleanup", {
            "processes": cleanup,
            "scope": "individual owned leaders and process groups only",
            "detached_descendant_extinction_owner": "scripts/lib/managed-memory.mts",
        })
        require(
            all(item["leader_joined"] and item["group_observed_empty"] for item in cleanup),
            "owned_native_process_cleanup_incomplete",
        )


def native_owned():
    # The product wrapper can detach child groups. Its existing managed-memory
    # owner covers the complete native subtree and verifies cgroup extinction;
    # the inner Python receipts describe only individual leaders/process groups.
    owner = r'''
import fs from "node:fs";
import path from "node:path";
import { runManagedCommand } from "./scripts/lib/managed-child-process.mts";
import { readProcessMemoryCapacity } from "./scripts/lib/process-memory.mts";

const report = {
  source_sha: process.env.SOURCE_SHA,
  owner: "scripts/lib/managed-memory.mts",
  memory_limit_bytes: null,
  owned_scope_assigned: false,
  command_exit_code: null,
  owner_returned_after_extinction_check: false,
  error_code: null,
  process_tree_state: null,
};
try {
  const capacity = readProcessMemoryCapacity({});
  const available = [capacity.limitBytes, capacity.availableBytes]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (available.length === 0) throw Object.assign(new Error(), { code: "MEMORY_CAPACITY_UNKNOWN" });
  const limit = Math.min(3 * 1024 ** 3, Math.floor(Math.min(...available) * 0.75));
  if (limit < 512 * 1024 ** 2) throw Object.assign(new Error(), { code: "MEMORY_CAPACITY_INSUFFICIENT" });
  report.memory_limit_bytes = limit;
  report.command_exit_code = await runManagedCommand({
    bin: "dbus-run-session",
    args: ["--", "python3", process.env.P05_PROOF_RUNNER, "native-in-session"],
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: "inherit",
    shell: false,
    memoryLimitBytes: limit,
    timeoutMs: 15 * 60_000,
    timeoutKillGraceMs: 30_000,
    signalKillGraceMs: 30_000,
    onMemoryScope: () => { report.owned_scope_assigned = true; },
  });
  // managed-memory.mts returns only after cgroup.events reports populated=0
  // or the manager confirms removal of this invocation's unique owned scope.
  report.owner_returned_after_extinction_check = true;
  report.process_tree_state = "terminated";
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  report.error_code = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)
    ? code : "MANAGED_NATIVE_FAILED";
  const state = error && typeof error === "object" && "processTreeState" in error
    ? error.processTreeState : null;
  report.process_tree_state = ["terminated", "indeterminate", "signaled"].includes(state) ? state : null;
}
fs.writeFileSync(
  path.join(process.env.P05_PROOF_ROOT, "public", "native-cgroup-owner.json"),
  JSON.stringify(report, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
process.exitCode = report.command_exit_code === 0 && report.owner_returned_after_extinction_check ? 0 : 1;
'''
    code, _ = run_command(
        "native-owned-cgroup",
        ["node", "--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", owner],
    )
    report = json.loads((PUBLIC / "native-cgroup-owner.json").read_text())
    emit("native-cgroup-owner", report)
    require(
        code == 0 and report["command_exit_code"] == 0
        and report["owned_scope_assigned"] is True
        and report["owner_returned_after_extinction_check"] is True,
        "native_owned_cgroup_failed",
    )


def main():
    mode = sys.argv[1]
    if mode == "identity":
        identity()
    elif mode == "source-integrity":
        source_integrity()
    elif mode == "run":
        require(sys.argv[3] == "--", "command_separator_missing")
        checked(sys.argv[2], sys.argv[4:])
    elif mode == "regressions":
        run_tests("private-receipts", [PRIVATE_TEST], expected=5)
        run_tests("computer-receipts", [COMPUTER_TEST], expected=32)
        run_tests("affected-consumers", SIBLINGS)
    elif mode == "base-red":
        base_red()
    elif mode == "format":
        checked("format", ["pnpm", "format:check", "--no-error-on-unmatched-pattern", "--", *CHANGED_FILES])
    elif mode == "deadcode":
        code, output = run_command("deadcode-unused-files", ["pnpm", "deadcode:unused-files"], capture=True)
        emit("deadcode-owned-path", {
            "command_exit_code": code, "aggregate_passed": code == 0,
            "owned_proof_script": PROOF_SCRIPT, "owned_path_appears_in_output": PROOF_SCRIPT in output,
            "note": "An absent owned path does not qualify a failing aggregate check.",
        })
        require(code == 0, "deadcode_unused_files_failed")
    elif mode == "built-identity":
        built_identity()
    elif mode == "built-integrity":
        built_identity(verify=True)
    elif mode == "overlay-workflow":
        destination = ROOT / WORKFLOW_PATH
        require(not destination.exists(), "workflow_overlay_destination_exists")
        destination.write_bytes((PROOF / "workflow.yml").read_bytes())
        source_integrity()
    elif mode == "native":
        native_owned()
    elif mode == "native-in-session":
        native_in_session()
    else:
        raise ProofFailure("unsupported_runner_mode")


if __name__ == "__main__":
    os.umask(0o077)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        main()
    except BaseException as error:
        print("P05_PROOF_FAILURE " + sanitize(type(error).__name__ + ": " + str(error)), flush=True)
        sys.exit(1)
