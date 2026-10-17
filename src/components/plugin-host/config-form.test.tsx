import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigForm } from "./config-form"
import * as api from "@/lib/plugin-host/api"
import type { ConfigSchema, PluginConfig } from "@/lib/plugin-host/types"

vi.mock("@/lib/plugin-host/api", () => ({
  pluginHostSetConfig: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      save: "Save Configuration",
      saving: "Saving...",
      saveSuccess: "Configuration saved",
      secretConfigured: "Configured",
      secretUpdatePlaceholder: "Enter new secret to replace",
      secretClear: "Clear",
      secretWillClear: "Will be cleared on save",
      required: "Required",
      invalidNumber: "Must be a valid number",
      invalidInteger: "Must be an integer",
    }
    return translations[key] || key
  },
}))

describe("ConfigForm", () => {
  const schema: ConfigSchema = {
    type: "object",
    required: ["apiKey", "model"],
    properties: {
      model: {
        type: "string",
        title: "Model Name",
        description: "The AI model to use",
        default: "gpt-4o",
      },
      temperature: {
        type: "number",
        title: "Temperature",
        default: 0.7,
      },
      maxTokens: {
        type: "integer",
        title: "Max Tokens",
        default: 1000,
      },
      debugMode: {
        type: "boolean",
        title: "Debug Mode",
        default: false,
      },
      mode: {
        type: "string",
        title: "Mode",
        enum: ["fast", "balanced", "precise"],
        default: "balanced",
      },
      apiKey: {
        type: "string",
        title: "API Key",
        format: "secret",
        description: "Secret API token",
      },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders form fields correctly based on schema", () => {
    render(<ConfigForm pluginId="test-plugin" schema={schema} />)

    expect(screen.getByLabelText(/Model Name/i)).toBeDefined()
    expect(screen.getByLabelText(/Temperature/i)).toBeDefined()
    expect(screen.getByLabelText(/Max Tokens/i)).toBeDefined()
    expect(screen.getByLabelText(/Debug Mode/i)).toBeDefined()
    expect(screen.getByLabelText(/API Key/i)).toBeDefined()
  })

  it("shows secret as configured if in initialConfig.secretsSet", () => {
    const initialConfig: PluginConfig = {
      values: { model: "claude-3-5-sonnet" },
      secretsSet: ["apiKey"],
    }

    render(
      <ConfigForm
        pluginId="test-plugin"
        schema={schema}
        initialConfig={initialConfig}
      />
    )

    expect(screen.getByText("Configured")).toBeDefined()
    expect(
      screen.getByPlaceholderText("Enter new secret to replace")
    ).toBeDefined()
  })

  it("validates required fields and stops submit if missing", async () => {
    render(<ConfigForm pluginId="test-plugin" schema={schema} />)

    // Clear required model field
    const modelInput = screen.getByLabelText(/Model Name/i)
    fireEvent.change(modelInput, { target: { value: "" } })

    const saveBtn = screen.getByRole("button", { name: "Save Configuration" })
    fireEvent.click(saveBtn)

    expect(await screen.findAllByText("Required")).toHaveLength(2) // model and apiKey
    expect(api.pluginHostSetConfig).not.toHaveBeenCalled()
  })

  it("submits values and secrets to pluginHostSetConfig", async () => {
    const initialConfig: PluginConfig = {
      values: { model: "claude-3" },
      secretsSet: ["apiKey"],
    }

    vi.mocked(api.pluginHostSetConfig).mockResolvedValueOnce({
      values: { model: "claude-3-opus" },
      secretsSet: ["apiKey"],
    })

    const onSave = vi.fn()
    render(
      <ConfigForm
        pluginId="test-plugin"
        schema={schema}
        initialConfig={initialConfig}
        onSave={onSave}
      />
    )

    const modelInput = screen.getByLabelText(/Model Name/i)
    fireEvent.change(modelInput, { target: { value: "claude-3-opus" } })

    const apiKeyInput = screen.getByPlaceholderText(
      "Enter new secret to replace"
    )
    fireEvent.change(apiKeyInput, { target: { value: "sk-new-key" } })

    const saveBtn = screen.getByRole("button", { name: "Save Configuration" })
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(api.pluginHostSetConfig).toHaveBeenCalledWith(
        "test-plugin",
        expect.objectContaining({
          model: "claude-3-opus",
        }),
        { apiKey: "sk-new-key" }
      )
      expect(onSave).toHaveBeenCalled()
    })
  })

  it("allows clearing an existing secret", async () => {
    const initialConfig: PluginConfig = {
      values: { model: "claude-3" },
      secretsSet: ["apiKey"],
    }

    vi.mocked(api.pluginHostSetConfig).mockResolvedValueOnce({
      values: { model: "claude-3" },
      secretsSet: [],
    })

    render(
      <ConfigForm
        pluginId="test-plugin"
        schema={schema}
        initialConfig={initialConfig}
      />
    )

    // Click clear
    const clearBtn = screen.getByRole("button", { name: "Clear" })
    fireEvent.click(clearBtn)

    expect(screen.getByText("Will be cleared on save")).toBeDefined()
  })
})
