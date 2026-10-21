#!/usr/bin/env python3
"""A stdlib-only ACP v1 agent for tests and the live check.

Usage: fake_acp_agent.py '<json script>'   (or a path to a .json file)

Script keys (all optional):
  log:              path; every message received is appended as a JSON line
  protocolVersion:  what initialize answers (default 1)
  closeCap:         advertise sessionCapabilities.close (default true)
  sessionNewError:  {code, message} to answer session/new with
  initDelay:        seconds to wait before answering initialize
  sessionNewDelay:  seconds to wait before answering session/new
  junkStdout:       print non-JSON lines on stdout before answering
  grandchild:       path; spawn a sleeping grandchild and write its pid there
  turns:            list of step lists, one per session/prompt (the last repeats)
  authMethods:      what initialize lists (default [])
  promptCapabilities: what initialize says prompts may carry (default {})
  authenticate:     "ok" (default), "error", or "hang" (never answers)
  configOptions:    session/new's configOptions; session/set_config_option
                    sets currentValue and answers the full list
  models:           session/new's legacy models field (session/set_model)
  logoutCap:        advertise agentCapabilities.auth.logout (default false)
  env_file:         path; on initialize write {BROWSER, GEMINI_API_KEY set?,
                    GEMINI_CLI_SYSTEM_SETTINGS_PATH} there

Steps (dicts, run in order):
  {"chunk": text} {"thought": text} {"plan": [entries]}
  {"tool_call": {...}} {"tool_update": {...}}   session/update payloads
  {"permission": {"options": "all"|"no_reject"|"reject_only", "toolCall": {...}},
   "cancelAfter": seconds, "echo": false}  request permission; the outcome is
                            echoed as a chunk unless echo is false
  {"fs_read": path}         call fs/read_text_file; the error code is echoed
  {"echo_env": NAME}        chunk with the env var's value or "unset"
  {"sleep": seconds}
  {"wait_cancel": true}     wait for session/cancel, then end the turn "cancelled"
  {"ignore_cancel": true}   hang forever, even after session/cancel
  {"crash": code}           exit right away with that code
  {"stop": reason}          the stopReason (default end_turn)
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time

_out_lock = threading.Lock()
_responses: dict[int, "queue.Queue[dict]"] = {}
_next_id = [1000]
_cancelled = threading.Event()
SCRIPT: dict = {}


def log(message: dict) -> None:
    path = SCRIPT.get("log")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(message) + "\n")


def send(message: dict) -> None:
    line = json.dumps({"jsonrpc": "2.0", **message}) + "\n"
    with _out_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def request(method: str, params: dict, *, then_cancel_after: float | None = None) -> dict:
    _next_id[0] += 1
    rid = _next_id[0]
    box: "queue.Queue[dict]" = queue.Queue()
    _responses[rid] = box
    send({"id": rid, "method": method, "params": params})
    if then_cancel_after is not None:
        def cancel_later() -> None:
            time.sleep(then_cancel_after)
            send({"method": "$/cancel_request", "params": {"requestId": rid}})
        threading.Thread(target=cancel_later, daemon=True).start()
    return box.get()


def update(session_id: str, payload: dict) -> None:
    send({"method": "session/update", "params": {"sessionId": session_id, "update": payload}})


OPTIONS = {
    "all": [
        {"optionId": "a1", "name": "Allow once", "kind": "allow_once"},
        {"optionId": "a2", "name": "Always allow", "kind": "allow_always"},
        {"optionId": "r1", "name": "Reject", "kind": "reject_once"},
        {"optionId": "r2", "name": "Always reject", "kind": "reject_always"},
    ],
    "no_reject": [
        {"optionId": "a1", "name": "Allow once", "kind": "allow_once"},
        {"optionId": "a2", "name": "Always allow", "kind": "allow_always"},
    ],
    "always_only": [
        {"optionId": "a2", "name": "Always allow", "kind": "allow_always"},
        {"optionId": "r1", "name": "Reject", "kind": "reject_once"},
    ],
}


def run_turn(rid: int, session_id: str, steps: list) -> None:
    stop = "end_turn"
    for step in steps:
        if "chunk" in step:
            update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": step["chunk"]}})
        elif "thought" in step:
            update(session_id, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": step["thought"]}})
        elif "plan" in step:
            update(session_id, {"sessionUpdate": "plan", "entries": step["plan"]})
        elif "tool_call" in step:
            update(session_id, {"sessionUpdate": "tool_call", **step["tool_call"]})
        elif "tool_update" in step:
            update(session_id, {"sessionUpdate": "tool_call_update", **step["tool_update"]})
        elif "permission" in step:
            spec = step["permission"]
            reply = request("session/request_permission", {
                "sessionId": session_id, "toolCall": spec.get("toolCall", {"toolCallId": "call_1"}),
                "options": OPTIONS[spec.get("options", "all")]}, then_cancel_after=step.get("cancelAfter"))
            log({"permissionReply": reply})
            if step.get("echo") is False:
                continue
            if "error" in reply:
                text = f"permission:error:{reply['error'].get('code')}"
            else:
                outcome = reply.get("result", {}).get("outcome", {})
                text = f"permission:{outcome.get('outcome')}:{outcome.get('optionId', '')}"
            update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})
        elif "fs_read" in step:
            reply = request("fs/read_text_file", {"sessionId": session_id, "path": step["fs_read"]})
            log({"fsReply": reply})
            code = reply.get("error", {}).get("code")
            update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": f"fs:{code}"}})
        elif "echo_env" in step:
            value = os.environ.get(step["echo_env"], "unset")
            update(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": value}})
        elif "sleep" in step:
            time.sleep(step["sleep"])
        elif "wait_cancel" in step:
            _cancelled.wait()
            stop = "cancelled"
        elif "ignore_cancel" in step:
            while True:
                time.sleep(3600)
        elif "crash" in step:
            sys.stdout.flush()
            os._exit(int(step["crash"]))
        elif "stop" in step:
            stop = step["stop"]
    send({"id": rid, "result": {"stopReason": stop}})


def main() -> None:
    global SCRIPT
    raw = sys.argv[1] if len(sys.argv) > 1 else "{}"
    if not raw.lstrip().startswith("{"):
        with open(raw, encoding="utf-8") as handle:
            raw = handle.read()
    SCRIPT = json.loads(raw)
    if SCRIPT.get("grandchild"):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        with open(SCRIPT["grandchild"], "w", encoding="utf-8") as handle:
            handle.write(str(child.pid))
    if SCRIPT.get("junkStdout"):
        with _out_lock:
            sys.stdout.write("this is not json\n[1, 2, 3]\n\"a string\"\n")
            sys.stdout.flush()
    turns = SCRIPT.get("turns") or [[{"chunk": "hello"}]]
    prompt_count = 0
    session_id = "sess_fake_1"
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        log(message)
        method = message.get("method")
        if method is None:
            box = _responses.pop(message.get("id"), None)
            if box is not None:
                box.put(message)
            continue
        rid = message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            time.sleep(float(SCRIPT.get("initDelay") or 0))
            caps = {"loadSession": False, "promptCapabilities": SCRIPT.get("promptCapabilities", {}),
                    "mcpCapabilities": {"http": False}}
            if SCRIPT.get("closeCap", True):
                caps["sessionCapabilities"] = {"close": {}}
            if SCRIPT.get("logoutCap"):
                caps["auth"] = {"logout": {}}
            if SCRIPT.get("env_file"):
                with open(SCRIPT["env_file"], "w", encoding="utf-8") as handle:
                    json.dump({"BROWSER": os.environ.get("BROWSER"),
                               "GEMINI_API_KEY": os.environ.get("GEMINI_API_KEY"),
                               "GEMINI_CLI_SYSTEM_SETTINGS_PATH": os.environ.get("GEMINI_CLI_SYSTEM_SETTINGS_PATH")},
                              handle)
            send({"id": rid, "result": {"protocolVersion": SCRIPT.get("protocolVersion", 1),
                                        "agentCapabilities": caps,
                                        "agentInfo": {"name": "fake-acp-agent", "version": "1.0.0"},
                                        "authMethods": SCRIPT.get("authMethods", [])}})
        elif method == "authenticate":
            mode = SCRIPT.get("authenticate", "ok")
            if mode == "error":
                send({"id": rid, "error": {"code": -32000, "message": "Authentication failed"}})
            elif mode != "hang":
                send({"id": rid, "result": {}})
        elif method == "logout":
            send({"id": rid, "result": {}})
        elif method == "session/set_config_option":
            options = SCRIPT.get("configOptions") or []
            for option in options:
                if option.get("id") == params.get("configId"):
                    option["currentValue"] = params.get("value")
            send({"id": rid, "result": {"configOptions": options}})
        elif method == "session/set_model":
            send({"id": rid, "result": {}})
        elif method == "session/new":
            time.sleep(float(SCRIPT.get("sessionNewDelay") or 0))
            if SCRIPT.get("sessionNewError"):
                send({"id": rid, "error": SCRIPT["sessionNewError"]})
            else:
                result = {"sessionId": session_id}
                if SCRIPT.get("configOptions") is not None:
                    result["configOptions"] = SCRIPT["configOptions"]
                if SCRIPT.get("models") is not None:
                    result["models"] = SCRIPT["models"]
                send({"id": rid, "result": result})
        elif method == "session/prompt":
            steps = turns[min(prompt_count, len(turns) - 1)]
            prompt_count += 1
            _cancelled.clear()
            threading.Thread(target=run_turn, args=(rid, params.get("sessionId"), steps), daemon=True).start()
        elif method == "session/cancel":
            _cancelled.set()
        elif method == "session/close":
            send({"id": rid, "result": {}})
        elif rid is not None:
            send({"id": rid, "error": {"code": -32601, "message": "Method not found"}})
    # stdin EOF: a well-behaved agent exits.


if __name__ == "__main__":
    main()
