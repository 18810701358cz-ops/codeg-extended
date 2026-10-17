"use client"

import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from "react"
import {
  getSlotContributions,
  subscribeSlot,
  type RegisteredSlotContribution,
} from "@/lib/plugin-host/slots"
import type { SlotName } from "@/lib/plugin-host/types"

interface ErrorBoundaryProps {
  pluginId: string
  contributionId: string
  fallback?: ReactNode
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

export class ContributionErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `[plugin-host] Contribution "${this.props.contributionId}" from plugin "${this.props.pluginId}" crashed:`,
      error,
      errorInfo
    )
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null
    }
    return this.props.children
  }
}

function SlotContributionMount({
  contribution,
}: {
  contribution: RegisteredSlotContribution
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let cleanup: void | (() => void)
    try {
      cleanup = contribution.mount(el)
    } catch (err) {
      console.error(
        `[plugin-host] Error mounting contribution "${contribution.id}" from "${contribution.pluginId}":`,
        err
      )
    }

    return () => {
      if (typeof cleanup === "function") {
        try {
          cleanup()
        } catch (err) {
          console.error(
            `[plugin-host] Error unmounting contribution "${contribution.id}" from "${contribution.pluginId}":`,
            err
          )
        }
      }
      el.innerHTML = ""
    }
  }, [contribution])

  return (
    <div
      ref={containerRef}
      data-plugin-id={contribution.pluginId}
      data-contribution-id={contribution.id}
      className="inline-flex items-center"
    />
  )
}

const emptyContributions: RegisteredSlotContribution[] = []

export function PluginSlot({
  name,
  className,
}: {
  name: SlotName
  className?: string
}) {
  const subscribe = useCallback(
    (notify: () => void) => subscribeSlot(name, notify),
    [name]
  )
  const getSnapshot = useCallback(() => getSlotContributions(name), [name])
  const getServerSnapshot = useCallback(() => emptyContributions, [])

  const contributions = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot
  )

  if (contributions.length === 0) {
    return null
  }

  return (
    <div
      data-slot-name={name}
      className={className ?? "inline-flex items-center gap-2"}
    >
      {contributions.map((contribution) => (
        <ContributionErrorBoundary
          key={`${contribution.pluginId}:${contribution.id}`}
          pluginId={contribution.pluginId}
          contributionId={contribution.id}
        >
          <SlotContributionMount contribution={contribution} />
        </ContributionErrorBoundary>
      ))}
    </div>
  )
}
