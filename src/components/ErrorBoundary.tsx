import { Component, type ReactNode } from 'react'

// A drawing error inside the result screen used to leave the whole page blank (a part saved with an empty
// reference, 2026-10-29). This keeps the header and says what happened, with a way back to the start.
export default class ErrorBoundary extends Component<{ children: ReactNode; onReset: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Result screen failed to draw:', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" data-testid="screen-error" style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', lineHeight: 1.6 }}>
        <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>이 회로를 화면에 그리지 못했습니다</h2>
        <p style={{ margin: '0 0 6px', color: 'var(--sf-fg-muted)' }}>
          저장된 회로에 화면이 읽지 못하는 부분이 있습니다. 처음 화면으로 돌아가 다른 기록을 열거나 새로 만들어 주세요.
        </p>
        <p style={{ margin: '0 0 16px', fontFamily: 'var(--sf-font-mono)', fontSize: 12, color: 'var(--sf-fg-dim)' }}>{this.state.error.message}</p>
        <button type="button" onClick={() => { this.setState({ error: null }); this.props.onReset() }}
          style={{ padding: '6px 14px', borderRadius: 4, border: '1px solid var(--sf-line)', background: 'var(--sf-bg-3)', cursor: 'pointer' }}>
          처음으로
        </button>
      </div>
    )
  }
}
