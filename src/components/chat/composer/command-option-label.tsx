import type { AvailableCommandInfo } from "@/lib/types"

import {
  commandInputHint,
  commandInvocationToken,
} from "./invocation-reference"

/**
 * One advertised command as a composer's `/` popup lists it: the token it runs
 * as, the argument the agent says it takes, then its description. Shared by
 * the chat composer and the automation editor so the two rows stay identical.
 */
export function CommandOptionLabel({
  command,
}: {
  command: AvailableCommandInfo
}) {
  const hint = commandInputHint(command)
  return (
    <>
      <span className="shrink-0 font-mono text-primary">
        {commandInvocationToken(command.name)}
      </span>
      {hint ? (
        <span
          className="max-w-[40%] shrink-0 truncate font-mono text-xs text-muted-foreground/80"
          title={hint}
        >
          {hint}
        </span>
      ) : null}
      <span className="truncate text-xs text-muted-foreground">
        {command.description}
      </span>
    </>
  )
}
