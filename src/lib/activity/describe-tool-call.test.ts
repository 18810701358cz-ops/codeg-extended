import { describe, expect, it } from "vitest"

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { describeToolCall, toolStepKind } from "./describe-tool-call"

let seq = 0
function call(
  toolName: string,
  input: unknown,
  overrides: Partial<AdaptedToolCallPart> = {}
): AdaptedToolCallPart {
  seq += 1
  return {
    type: "tool-call",
    toolCallId: `call-${seq}`,
    toolName,
    input:
      input === null
        ? null
        : typeof input === "string"
          ? input
          : JSON.stringify(input),
    state: "output-available",
    output: null,
    ...overrides,
  }
}

describe("toolStepKind", () => {
  const cases: Array<[string, unknown, string]> = [
    // Claude Code
    ["Read", { file_path: "/r/a.ts" }, "read"],
    ["Grep", { pattern: "x" }, "search"],
    ["Glob", { pattern: "**/*.ts" }, "glob"],
    ["Bash", { command: "ls" }, "command"],
    ["PowerShell", { command: "dir" }, "command"],
    [
      "Edit",
      { file_path: "/r/a.ts", old_string: "a", new_string: "b" },
      "edit",
    ],
    ["Write", { file_path: "/r/a.ts", content: "x" }, "edit"],
    ["NotebookEdit", { notebook_path: "/r/n.ipynb" }, "edit"],
    ["WebFetch", { url: "https://a.dev" }, "fetch"],
    ["WebSearch", { query: "q" }, "web-search"],
    ["Skill", { skill: "pdf" }, "skill"],
    ["TodoWrite", { todos: [] }, "todo"],
    ["Agent", { prompt: "p", subagent_type: "Explore" }, "agent"],
    ["Task", { prompt: "p", subagent_type: "Explore" }, "generic"],
    ["ExitPlanMode", { plan: "# P" }, "plan-mode"],
    ["AskUserQuestion", { questions: [] }, "question"],
    ["mcp__linear__get_issue", { id: "HVAC-1" }, "mcp"],
    // codeg's own MCP companions are never third-party MCP rows
    ["mcp__codeg-mcp__delegate_to_agent", { task: "t" }, "delegation"],
    [
      "mcp__codeg-mcp__get_delegation_status",
      { task_ids: [] },
      "delegation-status",
    ],
    [
      "mcp__codeg-mcp__cancel_delegation",
      { task_id: "t" },
      "delegation-cancel",
    ],
    [
      "mcp__codeg-mcp__resume_delegation",
      { task_id: "t" },
      "delegation-resume",
    ],
    ["mcp__codeg-mcp__check_user_feedback", {}, "feedback"],
    ["mcp__codeg-mcp__task_progress", {}, "workbench"],
    // codex
    ["exec_command", { cmd: "ls" }, "command"],
    ["shell_command", { command: "ls" }, "command"],
    ["apply_patch", "*** Begin Patch\n*** End Patch", "edit"],
    ["wait", { cell_id: "7" }, "shell-session"],
    ["write_stdin", { session_id: 7, chars: "" }, "shell-session"],
    ["codex_script", { source: "x" }, "script"],
    ["view_image", { path: "/r/a.png" }, "read"],
    ["create_goal", { objective: "o" }, "goal"],
    ["linear/get_issue", { id: "1" }, "mcp"],
    // Cline
    ["execute_command", { command: "ls" }, "command"],
    ["list_files", { path: "src" }, "glob"],
    ["search_files", { regex: "x" }, "search"],
    ["attempt_completion", { result: "done" }, "completion"],
    ["use_mcp_tool", { server_name: "gh", tool_name: "search" }, "mcp"],
    // pi
    ["find", { pattern: "*.ts" }, "glob"],
    ["ls", { path: "src" }, "list"],
    // Grok
    ["run_terminal_command", { command: "ls" }, "command"],
    // unknown
    ["lsp_diagnostics", { path: "a.ts" }, "generic"],
  ]
  it.each(cases)("%s → %s", (name, input, expected) => {
    expect(toolStepKind(call(name, input))).toBe(expected)
  })

  it("routes a compaction marker regardless of the tool name", () => {
    expect(
      toolStepKind(call("tool", null, { meta: { contextCompaction: true } }))
    ).toBe("compaction")
  })
})

describe("describeToolCall: exploration", () => {
  it("describes a read with its line count and range", () => {
    const tool = describeToolCall(
      call(
        "Read",
        { file_path: "/repo/agent/src/q.py", offset: 40, limit: 20 },
        { output: JSON.stringify({ start_line: 40, content: "a\nb\nc" }) }
      )
    )
    expect(tool.target).toEqual({
      text: "src/q.py",
      full: "/repo/agent/src/q.py",
      path: "/repo/agent/src/q.py",
    })
    expect(tool.detail).toBe("L40–59")
    expect(tool.metric).toEqual({ kind: "lines", count: 3 })
  })

  it("does not count lines of a read still in flight", () => {
    const tool = describeToolCall(
      call("Read", { file_path: "/r/a.ts" }, { state: "input-available" })
    )
    expect(tool.status).toBe("running")
    expect(tool.metric).toBeNull()
  })

  it("counts grep hits and shows the scope", () => {
    const tool = describeToolCall(
      call(
        "Grep",
        { pattern: "source_bindings", path: "/repo/agent/src" },
        { output: "a.py:1:x\na.py:9:y\nb.py:3:z\nc.py:4:w" }
      )
    )
    expect(tool.target?.text).toBe("source_bindings")
    expect(tool.detail).toBe("agent/src")
    expect(tool.metric).toEqual({ kind: "matches", count: 4, files: 3 })
  })

  it("reports a grep that matched nothing", () => {
    const tool = describeToolCall(
      call("Grep", { pattern: "zzz" }, { output: "" })
    )
    expect(tool.status).toBe("succeeded")
    expect(tool.metric).toEqual({ kind: "noMatch" })
  })

  it("treats a pattern-less glob as a listing", () => {
    const tool = describeToolCall(
      call("list_files", { path: "/repo/src" }, { output: "a.ts\nb.ts" })
    )
    expect(tool.kind).toBe("list")
    expect(tool.metric).toEqual({ kind: "files", count: 2 })
  })

  it("shows a fetch's URL without its scheme", () => {
    expect(
      describeToolCall(call("WebFetch", { url: "https://react.dev/learn" }))
        .target?.text
    ).toBe("react.dev/learn")
  })
})

describe("describeToolCall: commands", () => {
  it("shows the command, not Claude's description", () => {
    const tool = describeToolCall(
      call("Bash", {
        command: "pnpm --filter web test",
        description: "Run web unit tests",
      })
    )
    expect(tool.command).toMatchObject({
      display: "pnpm --filter web test",
      lineCount: 1,
      heredoc: null,
      description: "Run web unit tests",
      session: null,
    })
    expect(tool.exit).toBeNull()
  })

  it("reports a failed command's exit code", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "pnpm test" },
        {
          state: "output-error",
          output: "Tests: 1 failed\n\nExit code 1",
          errorText: "Tests: 1 failed\n\nExit code 1",
        }
      )
    )
    expect(tool.status).toBe("failed")
    expect(tool.exit).toEqual({ code: 1, signal: null })
  })

  it("prefers the exit code the transcript kept as a field", () => {
    const tool = describeToolCall(
      call(
        "bash",
        { command: "make" },
        {
          state: "output-error",
          output: "boom\n\nExit code 1",
          errorText: "boom\n\nExit code 1",
          exitCode: 2,
        }
      )
    )
    expect(tool.exit).toEqual({ code: 2, signal: null })
  })

  it("leaves the exit unknown when a failure reports none", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "x" },
        { state: "output-error", errorText: "something broke" }
      )
    )
    expect(tool.exit).toBeNull()
  })

  it("recognizes a heredoc script", () => {
    const tool = describeToolCall(
      call("Bash", { command: "python - <<'PY'\nprint(1)\nprint(2)\nPY" })
    )
    expect(tool.command?.heredoc).toEqual({
      head: "python - <<'PY'",
      interpreter: "python",
      bodyLines: 2,
    })
    expect(tool.command?.lineCount).toBe(4)
  })

  it("flags a background launch with its task id", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "python regen.py", run_in_background: true },
        {
          output:
            "Command running in background with ID: beecec7d. Output is being written to: /tmp/x",
        }
      )
    )
    expect(tool.background).toEqual({ taskId: "beecec7d" })
  })

  it("flags codex's backgrounded call while it is unsettled", () => {
    const meta = { jetbrains: { air: { asyncTasks: { backgrounded: true } } } }
    expect(
      describeToolCall(
        call(
          "exec_command",
          { cmd: "pnpm dev" },
          { state: "input-available", meta }
        )
      ).background
    ).toEqual({ taskId: null })
    expect(
      describeToolCall(call("exec_command", { cmd: "pnpm dev" }, { meta }))
        .background
    ).toBeNull()
  })

  it("reads codex's wall time", () => {
    const tool = describeToolCall(
      call(
        "exec_command",
        { cmd: "make" },
        { output: "Chunk ID: 1\nWall time: 14.2 seconds\nOutput:\nok" }
      )
    )
    expect(tool.command?.durationMs).toBe(14200)
  })

  it("describes codex's session tools", () => {
    expect(
      describeToolCall(
        call("wait", { cell_id: "17", session_command: "bash -lc 'pnpm dev'" })
      ).command
    ).toMatchObject({
      display: "pnpm dev",
      session: { verb: "wait", sessionId: "17", stdin: null },
    })
    expect(
      describeToolCall(call("write_stdin", { session_id: 17, chars: "\u0003" }))
        .command?.session
    ).toEqual({ verb: "stdin", sessionId: "17", stdin: "\u0003" })
    expect(
      describeToolCall(call("wait", { cell_id: "17", terminate: true })).command
        ?.session?.verb
    ).toBe("terminate")
  })
})

describe("describeToolCall: edits", () => {
  it("names a single file and totals its lines", () => {
    const tool = describeToolCall(
      call("Edit", {
        file_path: "/repo/agent/q.py",
        old_string: "a",
        new_string: "b\nc\nd",
      })
    )
    expect(tool.target).toMatchObject({ path: "/repo/agent/q.py" })
    expect(tool.metric).toEqual({ kind: "diff", additions: 3, deletions: 1 })
  })

  it("hides the counts while the edit is still running", () => {
    const tool = describeToolCall(
      call(
        "Edit",
        { file_path: "/r/a.ts", old_string: "a", new_string: "b" },
        { state: "input-available" }
      )
    )
    expect(tool.metric).toBeNull()
  })

  it("leaves the target empty for a multi-file patch", () => {
    const patch =
      "*** Begin Patch\n*** Update File: a.ts\n+x\n*** Update File: b.ts\n-y\n*** End Patch"
    const tool = describeToolCall(call("apply_patch", patch))
    expect(tool.files).toHaveLength(2)
    expect(tool.target).toBeNull()
    expect(tool.metric).toEqual({ kind: "diff", additions: 1, deletions: 1 })
  })
})

describe("describeToolCall: MCP and generic tools", () => {
  it("splits the server off and summarizes arguments and result", () => {
    const tool = describeToolCall(
      call(
        "mcp__linear__get_issue",
        { id: "HVAC-212" },
        {
          output: JSON.stringify({
            title: "Inactive bindings leak into report",
            state: "In Progress",
          }),
        }
      )
    )
    expect(tool.mcp).toEqual({ server: "linear", tool: "get_issue" })
    expect(tool.target).toEqual({ text: "get_issue" })
    expect(tool.detail).toBe("HVAC-212 · Inactive bindings leak into report")
  })

  it("reads Cline's use_mcp_tool envelope", () => {
    const tool = describeToolCall(
      call("use_mcp_tool", {
        server_name: "github",
        tool_name: "search_code",
        arguments: { q: "useMemo" },
      })
    )
    expect(tool.mcp).toEqual({ server: "github", tool: "search_code" })
    expect(tool.detail).toBe("useMemo")
  })

  it("names an unknown tool by its raw name and first argument", () => {
    const tool = describeToolCall(
      call("lsp_diagnostics", { id: "1", path: "src/a.ts" })
    )
    expect(tool.target).toEqual({ text: "lsp_diagnostics" })
    expect(tool.detail).toBe("src/a.ts")
  })

  it("prefers Claude's skill marker", () => {
    expect(
      describeToolCall(
        call(
          "Skill",
          { skill: "x" },
          { meta: { claudeCode: { skill: "pdf" } } }
        )
      ).target
    ).toEqual({ text: "pdf" })
  })

  it("caches per part object", () => {
    const part = call("Read", { file_path: "/r/a.ts" })
    expect(describeToolCall(part)).toBe(describeToolCall(part))
  })
})

describe("describeToolCall: approvals", () => {
  it("carries the approval a detail load stamped on the call", () => {
    const tool = describeToolCall(
      call(
        "Bash",
        { command: "git commit -am wip" },
        {
          meta: {
            "codeg.approval": {
              option_kind: "allow_once",
              option_name: "Allow",
              origin: "user",
              decided_at: "2026-10-22T09:41:12Z",
            },
          },
        }
      )
    )
    expect(tool.approval).toEqual({
      decision: "allowOnce",
      optionName: "Allow",
      origin: "user",
      decidedAt: "2026-10-22T09:41:12Z",
    })
  })

  it("has none when the call carries no stamp", () => {
    expect(
      describeToolCall(call("Read", { file_path: "/r/a.ts" })).approval
    ).toBeNull()
  })
})
