#!/usr/bin/env python3
# SOT-1591 (solo mode live output): format a `claude -p --output-format stream-json --verbose` stream.
#
# Solo mode runs the WHOLE issue lifecycle in ONE `claude -p` session. With the default (text) output
# format, `-p` buffers everything until the end, so the run log / report file stay empty for the entire
# run and a hang (e.g. a stuck test command) is invisible. This formatter reads the stream-json events
# on stdin and:
#   1. prints a concise, LIVE progress line to stdout for each assistant text / tool use, so the run log
#      (and Discord mirror) show what the solo worker is doing in real time — including the exact command
#      it may be hanging on;
#   2. writes the worker's FINAL report text to the report file (argv[1]) so the pipeline's
#      `## Acceptance` / `## Next Action` parsing keeps working exactly as before.
#
# Robust by design: non-JSON lines (stderr / plain text) pass through untouched; malformed JSON is passed
# through; if no `result` event arrives (crash/timeout), the concatenated assistant text is used as the
# report so REPORT_FILE is never silently empty when the worker actually produced output.
import sys
import json


def _hint(inp):
    if not isinstance(inp, dict):
        return ""
    for k in ("command", "file_path", "path", "pattern", "description", "url"):
        v = inp.get(k)
        if v:
            return str(v).replace("\n", " ")
    return ""


def main():
    report_path = sys.argv[1] if len(sys.argv) > 1 else None
    final_result = None
    assistant_text = []

    for raw in sys.stdin:
        line = raw.rstrip("\n")
        s = line.strip()
        if not s:
            continue
        if not (s.startswith("{") and s.endswith("}")):
            print(line, flush=True)  # non-JSON (stderr / plain text) — surface as-is
            continue
        try:
            obj = json.loads(s)
        except Exception:
            print(line, flush=True)
            continue

        t = obj.get("type")
        if t == "system":
            if obj.get("subtype") == "init":
                print("[solo] session started", flush=True)
            # ignore noisy thinking_tokens / other system events
        elif t == "assistant":
            for item in (obj.get("message", {}) or {}).get("content", []) or []:
                it = item.get("type")
                if it == "text":
                    txt = (item.get("text") or "").strip()
                    if txt:
                        assistant_text.append(txt)
                        print(f"[solo] 💬 {txt.splitlines()[0][:200]}", flush=True)
                elif it == "tool_use":
                    name = item.get("name", "tool")
                    hint = _hint(item.get("input"))
                    print(f"[solo] 🔧 {name}: {hint[:200]}".rstrip(), flush=True)
        elif t == "result":
            r = obj.get("result")
            if isinstance(r, str):
                final_result = r

    report = final_result if (isinstance(final_result, str) and final_result.strip()) \
        else "\n\n".join(assistant_text)
    if report_path:
        try:
            with open(report_path, "w") as f:
                f.write(report or "")
        except Exception as e:
            print(f"[solo] WARN: could not write report file: {e}", flush=True)
    if report:
        print(report, flush=True)  # echo final report so end-of-run capture/Discord still sees it


if __name__ == "__main__":
    main()
