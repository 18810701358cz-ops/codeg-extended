"use client"

/**
 * Activity timeline gallery — a development page, built only with
 * CODEG_GALLERY=1 (see `pageExtensions` in next.config.ts).
 *
 * Renders fixture replies through the real pipeline (`adaptMessageTurn` →
 * `CompletedTurnContent`), outside any workspace, so every step kind and state
 * can be looked at and screenshotted side by side: `?view=` picks a scenario
 * (default: all), `?lang=` sets the interface language.
 */

import { useMemo, useState } from "react"

import { Message, MessageContent } from "@/components/ai-elements/message"
import { CompletedTurnContent } from "@/components/message/completed-turn-content"
import { ContentPartsRenderer } from "@/components/message/content-parts-renderer"
import {
  ActivityLiveProvider,
  type ActivityLiveValue,
} from "@/components/message/activity/activity-live-context"
import {
  StaticConnectionStoreProvider,
  type ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import {
  StaticDelegationProvider,
  type DelegationContextValue,
} from "@/contexts/delegation-context"
import {
  StaticWorkspaceActionsProvider,
  type WorkspaceActionsValue,
} from "@/contexts/workspace-context"
import { adaptMessageTurn } from "@/lib/adapters/ai-elements-adapter"
import {
  EMPTY_TOOL_APPROVALS,
  type ToolApprovalMap,
} from "@/lib/activity/approval"
import {
  fixtureLines,
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  MOCKUP_LIVE_TURN,
  MOCKUP_REPO,
  MOCKUP_USER_TURN,
  toolResult,
  toolUse,
} from "@/lib/activity/__fixtures__/mockup-turn"
import type { MessageTurn } from "@/lib/types"

const params =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams()

if (typeof window !== "undefined") {
  // Outside a backend: answer the language lookup, swallow the rest.
  const lang = params.get("lang") ?? "en"
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.endsWith("/api/get_system_language_settings")) {
      return new Response(JSON.stringify({ mode: "manual", language: lang }))
    }
    if (url.includes("/api/")) return new Response(JSON.stringify(null))
    return original(input, init)
  }
}

const STORE: ConnectionStoreApi = {
  getConnection: () => undefined,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
  getActiveKey: () => null,
  subscribeKey: () => () => {},
  subscribeActiveKey: () => () => {},
}

const DELEGATION: DelegationContextValue = {
  findByParentToolUseId: () => undefined,
  findByChildConversationId: () => undefined,
  findByTaskId: () => undefined,
}

const WORKSPACE = new Proxy(
  {},
  { get: () => () => {} }
) as unknown as WorkspaceActionsValue

const FAILURE_TURN: MessageTurn = {
  id: "turn-failure",
  role: "assistant",
  timestamp: "2026-10-22T09:00:00Z",
  duration_ms: 41000,
  blocks: [
    toolUse("f1", "Bash", { command: "pnpm --filter web build" }),
    toolResult(
      "f1",
      [
        "> web@0.1.0 build",
        "> next build",
        "",
        "Failed to compile.",
        "",
        "./lib/tasks.ts:12:7",
        "Type error: Property 'active' does not exist on type 'Binding'.",
        "",
        "[terminal exited: exit code: 1]",
      ].join("\n"),
      true
    ),
    toolUse("f2", "mcp__github__create_pull_request", {
      title: "Filter inactive bindings",
      head: "audit-followup",
    }),
    toolResult(
      "f2",
      JSON.stringify({ result: null, error: "GitHub API rate limit exceeded" }),
      true
    ),
    toolUse("f3", "Edit", {
      file_path: `${MOCKUP_REPO}/web/lib/tasks.ts`,
      old_string: "binding.active",
      new_string: "binding.isActive",
    }),
    toolResult(
      "f3",
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
      true
    ),
    {
      type: "text",
      text: "The build fails on a type error and I could not open the pull request.",
    },
  ],
}

const CODEX_TURN: MessageTurn = {
  id: "turn-codex",
  role: "assistant",
  timestamp: "2026-10-22T09:10:00Z",
  duration_ms: 96000,
  blocks: [
    {
      type: "thinking",
      text: "**Locating the report writer**\n\nThe regen script writes report.md; check how it orders bindings.",
    },
    toolUse("c1", "exec_command", {
      cmd: ["bash", "-lc", "rg -n 'def write_report' agent/src"],
    }),
    toolResult(
      "c1",
      JSON.stringify({
        formatted_output:
          "agent/src/hvac_agent/report.py:31:def write_report(tasks, path):",
        exit_code: 0,
      })
    ),
    toolUse("c2", "Read", {
      file_path: `${MOCKUP_REPO}/agent/src/hvac_agent/report.py`,
    }),
    toolResult("c2", fixtureLines(64, "report.py")),
    toolUse("c3", "grep", { pattern: "legacy_binding", path: "agent/src" }),
    toolResult("c3", ""),
    toolUse(
      "c4",
      "apply_patch",
      [
        "*** Begin Patch",
        "*** Update File: agent/src/hvac_agent/report.py",
        "@@ def write_report(tasks, path):",
        "-    for b in task.source_bindings:",
        "+    for b in sorted(task.source_bindings, key=lambda b: b.id):",
        "*** Add File: agent/src/hvac_agent/report_test.py",
        "+from hvac_agent.report import write_report",
        "+",
        "+def test_sorted():",
        "+    assert True",
        "*** End Patch",
      ].join("\n")
    ),
    toolResult(
      "c4",
      "Success. Updated the following files:\nM report.py\nA report_test.py"
    ),
    toolUse("c5", "exec_command", {
      cmd: ["bash", "-lc", "cd agent && .venv/bin/pytest -q"],
    }),
    toolResult(
      "c5",
      "Chunk ID: 8f2a\nWall time: 14.2 seconds\nProcess exited with code 0\nOutput:\n\u001b[32m....\u001b[0m\n4 passed in 13.87s"
    ),
    toolUse("c6", "wait", {
      cell_id: "7106",
      session_command: "bash -lc 'pnpm dev'",
    }),
    toolResult("c6", "ready - started server on 0.0.0.0:3000"),
    { type: "text", text: "Sorted the bindings and added a test." },
  ],
}

const AGENT_TURN: MessageTurn = {
  id: "turn-agent",
  role: "assistant",
  timestamp: "2026-10-22T09:20:00Z",
  duration_ms: 61000,
  blocks: [
    toolUse("a1", "Agent", {
      description: "Find binding consumers",
      prompt:
        "Find every consumer of source_bindings in the agent package and report which ones assume inactive bindings are present.",
      subagent_type: "Explore",
    }),
    {
      type: "tool_result",
      tool_use_id: "a1",
      is_error: false,
      output_preview:
        "Three consumers read `source_bindings`; only `report.py` assumes inactive bindings are present.",
      agent_stats: {
        agent_type: "Explore",
        status: "completed",
        total_duration_ms: 48000,
        total_tokens: 18400,
        total_tool_use_count: 2,
        read_count: 1,
        search_count: 1,
        tool_calls: [
          {
            tool_name: "Grep",
            input_preview: JSON.stringify({ pattern: "source_bindings" }),
            output_preview: "4 matches",
            is_error: false,
          },
          {
            tool_name: "Read",
            input_preview: JSON.stringify({
              file_path: `${MOCKUP_REPO}/agent/src/hvac_agent/report.py`,
            }),
            output_preview: fixtureLines(30, "report.py"),
            is_error: false,
          },
        ],
        timeline: [
          {
            type: "text",
            text: "I'll find every reader of `source_bindings` first.",
          },
          { type: "tool_call", childIndex: 0 },
          {
            type: "text",
            text: "Four matches; only `report.py` walks them directly, so I'll read it.",
          },
          { type: "tool_call", childIndex: 1 },
          {
            type: "text",
            text: "Three consumers read `source_bindings`; only `report.py` assumes inactive bindings are present.\n\n- `report.py` writes a line for every binding\n- `tasks.py` drops inactive bindings first\n- `audit.py` only counts them",
          },
        ],
      },
    },
    {
      type: "text",
      text: "Only `report.py` relies on inactive bindings being present.",
    },
  ],
}

const AGENT_LIVE_TURN: MessageTurn = {
  id: "turn-agent-live",
  role: "assistant",
  timestamp: "2026-10-22T09:25:00Z",
  blocks: [
    toolUse("a2", "Agent", {
      description: "Run the build",
      prompt:
        "Run `pnpm build` in /Users/me/work/my-app without changing any files, and report whether it succeeded with the exit code and the key output.",
      subagent_type: "general-purpose",
    }),
  ],
}

const WORKFLOW_TURN: MessageTurn = {
  id: "turn-workflow",
  role: "assistant",
  timestamp: "2026-10-22T09:40:00Z",
  duration_ms: 128000,
  blocks: [
    toolUse("w1", "TodoWrite", {
      todos: [
        { content: "Reproduce the report bug", status: "completed" },
        { content: "Filter inactive bindings", status: "in_progress" },
        { content: "Regenerate the audit report", status: "pending" },
      ],
    }),
    toolResult("w1", "Todos have been modified successfully."),
    toolUse("w2", "mcp__codeg-mcp__ask_user_question", {
      questions: [
        {
          question: "Which report format?",
          header: "Format",
          multiSelect: false,
          options: [
            { label: "Markdown (Recommended)", description: "Readable" },
            { label: "HTML", description: "Printable" },
          ],
        },
      ],
    }),
    toolResult(
      "w2",
      JSON.stringify({
        answers: [
          {
            header: "Format",
            question: "Which report format?",
            selected: ["Markdown (Recommended)"],
          },
        ],
        declined: false,
      })
    ),
    toolUse("w3", "mcp__codeg-mcp__check_user_feedback", {}),
    toolResult(
      "w3",
      '{"count":1,"feedback":[{"created_at":"2026-10-22T09:41:12Z","text":"Also keep the CSV export working"}]}'
    ),
    toolUse("w4", "mcp__codeg-mcp__task_progress", {
      message: "Bindings filtered; regenerating the report next",
    }),
    toolResult("w4", '{"recorded":true}'),
    toolUse("w5", "Bash", {
      command: "python scripts/export_csv.py",
      description: "Export CSV",
      run_in_background: true,
    }),
    toolResult(
      "w5",
      "Command running in background with ID: c0ffee12. Output is being written to: /tmp/claude/tasks/c0ffee12.output"
    ),
    toolUse("w6", "TaskOutput", { task_id: "c0ffee12", block: true }),
    toolResult(
      "w6",
      "<retrieval_status>success</retrieval_status>\n<task_id>c0ffee12</task_id>\n<task_type>local_bash</task_type>\n<status>completed</status>\n<exit_code>2</exit_code>\n<output>Traceback (most recent call last):\n  File \"scripts/export_csv.py\", line 9\nKeyError: 'active'</output>"
    ),
    toolUse("w7", "ExitPlanMode", {
      plan: "# Keep CSV export working\n\n1. Map `active` in the CSV writer\n2. Re-run the export\n3. Commit",
    }),
    toolResult("w7", "User has approved your plan."),
    { type: "text", text: "Plan approved — fixing the CSV writer next." },
  ],
}

const GLOBBED = [
  "lib/utils.ts",
  "components/validation-lab.tsx",
  "components/test-page-two.tsx",
  "components/demo-page.tsx",
  "components/test-lab.tsx",
  "components/cyberpunk-console.tsx",
  "components/experiment-console.tsx",
  "components/ui/input.tsx",
  "components/ui/textarea.tsx",
  "components/ui/button.tsx",
  "components/ui/card.tsx",
  "components/ui/dialog.tsx",
  "components/ui/select.tsx",
  "components/ui/tabs.tsx",
  "components/ui/tooltip.tsx",
  "hooks/use-mobile.ts",
  "hooks/use-toast.ts",
  "hooks/use-debounce.ts",
  "lib/format.ts",
].map((file) => `${MOCKUP_REPO}/web/${file}`)

const LAYOUT = `${MOCKUP_REPO}/web/app/layout.tsx`

const FILES_TURN: MessageTurn = {
  id: "turn-files",
  role: "assistant",
  timestamp: "2026-10-22T09:50:00Z",
  duration_ms: 52000,
  blocks: [
    {
      type: "thinking",
      text: "**Mapping the components**\n\nList the components first.\nThen read the layout's navigation.\nThen add the settings page and link it.",
    },
    toolUse("g1", "Glob", { pattern: "{lib,hooks,components}/**/*.{ts,tsx}" }),
    toolResult("g1", GLOBBED.join("\n")),
    toolUse("r1", "Read", { file_path: LAYOUT, offset: 10, limit: 6 }),
    toolResult(
      "r1",
      JSON.stringify({
        start_line: 10,
        content: [
          "export default function RootLayout({ children }) {",
          "  return (",
          '    <html lang="en">',
          "      <body>",
          '        <nav><a href="/">Home</a></nav>',
          "        {children}",
        ].join("\n"),
      })
    ),
    toolUse("w1", "Write", {
      file_path: `${MOCKUP_REPO}/web/app/settings/page.tsx`,
      content:
        "export default function SettingsPage() {\n  return <main>Settings</main>\n}\n",
    }),
    toolResult(
      "w1",
      `File created successfully at: ${MOCKUP_REPO}/web/app/settings/page.tsx`
    ),
    toolUse("e1", "Edit", {
      file_path: LAYOUT,
      old_string: '        <nav><a href="/">Home</a></nav>',
      new_string:
        '        <nav>\n          <a href="/">Home</a>\n          <a href="/settings">Settings</a>\n        </nav>',
    }),
    toolResult("e1", `The file ${LAYOUT} has been updated successfully.`),
    {
      type: "text",
      text: "Added the settings page and linked it from the navigation.",
    },
  ],
}

const POLLED_TASK_ID = "9e82cbc1-5d0e-4f6a-8b3c-2a1d0e9f8c7b"
const POLLED_TASK =
  "Run `pnpm build` in /Users/me/work/my-app without changing any files. Report whether it succeeded (exit code), the key output, and — if it failed — the full error with file paths and line numbers."

const RUNNING_TASK_ID = "5b4a74be-2c1d-4e8f-9a0b-6c5d4e3f2a1b"
const RUNNING_TASK =
  "Run the web unit tests in /Users/me/work/my-app and report every failure with its file path and line number."

const DELEGATION_TURN: MessageTurn = {
  id: "turn-delegation",
  role: "assistant",
  timestamp: "2026-10-22T10:00:00Z",
  duration_ms: 64000,
  blocks: [
    toolUse(
      "d1",
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: POLLED_TASK },
      {
        "codeg.delegation": {
          status: "completed",
          child_conversation_id: 78,
          task_id: POLLED_TASK_ID,
          task_preview: POLLED_TASK,
        },
      }
    ),
    toolResult(
      "d1",
      JSON.stringify({ task_id: POLLED_TASK_ID, status: "started" })
    ),
    {
      type: "text",
      text: "Codex is waiting for you to approve `pnpm build`; it will not go on until you confirm in Codeg. I'll keep waiting.",
    },
    toolUse("d2", "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [POLLED_TASK_ID],
      wait_ms: 60000,
    }),
    toolResult(
      "d2",
      JSON.stringify({
        task_id: POLLED_TASK_ID,
        status: "completed",
        text: "pnpm build succeeded, exit code 0.",
        duration_ms: 42000,
      })
    ),
    {
      type: "plan",
      entries: [
        {
          content: "Survey the project layout",
          priority: "high",
          status: "completed",
        },
        {
          content: "Read the core entry points",
          priority: "high",
          status: "completed",
        },
        {
          content: "Run the existing tests",
          priority: "medium",
          status: "completed",
        },
        {
          content: "Design the new feature",
          priority: "medium",
          status: "in_progress",
        },
        {
          content: "Write the implementation",
          priority: "medium",
          status: "pending",
        },
        { content: "Add tests and verify", priority: "low", status: "pending" },
      ],
    },
    // Still out when the reply ends: no step and no word from it yet.
    toolUse(
      "d3",
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: RUNNING_TASK },
      {
        "codeg.delegation": {
          status: "running",
          child_conversation_id: 79,
          task_id: RUNNING_TASK_ID,
          task_preview: RUNNING_TASK,
        },
      }
    ),
    toolResult(
      "d3",
      JSON.stringify({ task_id: RUNNING_TASK_ID, status: "started" })
    ),
    toolUse("d4", "mcp__codeg-mcp__get_delegation_status", {
      task_ids: [RUNNING_TASK_ID],
      wait_ms: 60000,
    }),
    toolResult(
      "d4",
      JSON.stringify({ task_id: RUNNING_TASK_ID, status: "running" })
    ),
    {
      type: "text",
      text: "The build passes; three of the six steps are done.",
    },
  ],
}

const TEXT_TURN: MessageTurn = {
  id: "turn-text",
  role: "assistant",
  timestamp: "2026-10-22T09:30:00Z",
  duration_ms: 3000,
  blocks: [{ type: "text", text: "Yes — the fix is already on `main`." }],
}

type Scenario = {
  id: string
  title: string
  turn: MessageTurn
  live?: boolean
  inProgress?: string[]
  /** The connection's answered permission requests, by tool call id. */
  approvals?: ToolApprovalMap
}

const MAIN_APPROVALS: ToolApprovalMap = {
  t13: {
    tool_call_id: "t13",
    option_kind: "allow_always",
    option_name: "Yes, and don't ask again for python commands",
    origin: "user",
    decided_at: "2026-10-22T09:44:02Z",
  },
  t15: {
    tool_call_id: "t15",
    option_kind: "allow_once",
    option_name: "Yes",
    origin: "chat_channel",
    decided_at: "2026-10-22T09:46:30Z",
  },
}

const SCENARIOS: Scenario[] = [
  {
    id: "main",
    title: "Reference turn",
    turn: MOCKUP_ASSISTANT_TURN,
    approvals: MAIN_APPROVALS,
  },
  {
    id: "live",
    title: "Live turn",
    turn: MOCKUP_LIVE_TURN,
    live: true,
    inProgress: ["l3"],
  },
  { id: "failure", title: "Failures", turn: FAILURE_TURN },
  { id: "codex", title: "Codex", turn: CODEX_TURN },
  { id: "agent", title: "Sub-agent", turn: AGENT_TURN },
  {
    id: "agent-live",
    title: "Sub-agent, running",
    turn: AGENT_LIVE_TURN,
    live: true,
    inProgress: ["a2"],
  },
  { id: "workflow", title: "Plans, questions and tasks", turn: WORKFLOW_TURN },
  { id: "delegation", title: "Delegation checks", turn: DELEGATION_TURN },
  { id: "files", title: "Files: match, read, write, edit", turn: FILES_TURN },
  { id: "text", title: "Text-only reply", turn: TEXT_TURN },
]

function ScenarioView({ scenario }: { scenario: Scenario }) {
  const [roundOpen, setRoundOpen] = useState(true)
  const adapted = useMemo(
    () =>
      adaptMessageTurn(
        scenario.turn,
        MOCKUP_ADAPTER_TEXT,
        scenario.live ?? false,
        scenario.inProgress ? new Set(scenario.inProgress) : undefined
      ),
    [scenario]
  )
  const live = useMemo<ActivityLiveValue>(
    () => ({
      awaitingToolCallId: null,
      approvals: scenario.approvals ?? EMPTY_TOOL_APPROVALS,
    }),
    [scenario]
  )
  return (
    <section data-scenario={scenario.id} className="space-y-3">
      <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {scenario.title}
      </h2>
      <ActivityLiveProvider value={live}>
        <Message from="assistant">
          <MessageContent>
            <CompletedTurnContent
              parts={adapted.content}
              durationMs={scenario.turn.duration_ms}
              completed={!scenario.live}
              currentRound
              roundOpen={roundOpen}
              onRoundOpenChange={setRoundOpen}
            />
          </MessageContent>
        </Message>
      </ActivityLiveProvider>
    </section>
  )
}

export default function ActivityGalleryPage() {
  const view = params.get("view") ?? "all"
  const user = useMemo(
    () => adaptMessageTurn(MOCKUP_USER_TURN, MOCKUP_ADAPTER_TEXT),
    []
  )
  const scenarios =
    view === "all" ? SCENARIOS : SCENARIOS.filter((s) => s.id === view)
  return (
    <StaticConnectionStoreProvider store={STORE}>
      <StaticDelegationProvider value={DELEGATION}>
        <StaticWorkspaceActionsProvider value={WORKSPACE}>
          <div className="chat-motion-scope min-h-screen bg-background text-foreground">
            <div
              id="gallery-root"
              className="mx-auto flex w-full max-w-[48rem] flex-col gap-8 px-6 py-8"
            >
              <Message from="user">
                <MessageContent>
                  <ContentPartsRenderer parts={user.content} role="user" />
                </MessageContent>
              </Message>
              {scenarios.map((scenario) => (
                <ScenarioView key={scenario.id} scenario={scenario} />
              ))}
            </div>
          </div>
        </StaticWorkspaceActionsProvider>
      </StaticDelegationProvider>
    </StaticConnectionStoreProvider>
  )
}
