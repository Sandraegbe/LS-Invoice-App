/**
 * PHASE 21, item 9 — A SECTION THAT FAILS SAYS SO, WITH A RETRY.
 *
 * The Assigned Invoices and Pickup screens are wrapped in this. If anything inside one of them
 * throws while it is being drawn, the person gets a short sentence and a Retry button instead of a
 * blank screen — and nothing here touches the session, so a failure can never sign anyone out.
 *
 * Retry clears the complaint and builds the section again from scratch (the key changes), which is
 * exactly what pressing the button again should do.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  /** Which section this is, so the message can say which one failed. */
  name: string
  children: ReactNode
}

interface State {
  error: string | null
  round: number
}

export class SectionBoundary extends Component<Props, State> {
  state: State = { error: null, round: 0 }

  static getDerivedStateFromError(cause: unknown): Partial<State> {
    return { error: cause instanceof Error && cause.message ? cause.message : 'This section could not be opened.' }
  }

  componentDidCatch(cause: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}] could not be drawn`, cause, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="space-y-2">
          <p className="form-error">
            {this.props.name} could not be opened: {this.state.error}
          </p>
          <button
            type="button"
            className="btn-line admin-small"
            onClick={() => this.setState((state) => ({ error: null, round: state.round + 1 }))}
          >
            Retry
          </button>
        </div>
      )
    }
    return <div key={this.state.round}>{this.props.children}</div>
  }
}
