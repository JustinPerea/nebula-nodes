import { Component, type ReactNode } from 'react'

/**
 * Catches a record the page can't draw (a shape it didn't expect) and shows one sentence with a way out,
 * instead of a blank page. It resets when a different record is opened (the parent keys it by record).
 */
export class RecordBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    // Kept for the developer console; the person sees the sentence below.
    console.error('The extraction page could not draw a record.', error)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="ex-record-failed" role="alert">
        <p className="ex-quiet ex-pad">This record couldn’t be shown.</p>
        <button type="button" className="ex-button ex-button-quiet" onClick={this.props.onClose}>
          Close
        </button>
      </div>
    )
  }
}
