import { Component } from 'react';

/**
 * One broken panel instead of a white page.
 *
 * React unmounts the whole tree when a render throws and nothing catches
 * it, so a mistake anywhere inside the tracker left `div#root` empty and
 * the dashboard — the filters, the other tabs, the sign-out — gone with
 * it. That has happened twice: a memo reading a Map before the first
 * load returned it, and a dependency array naming a const declared below
 * itself. Both were one line, and both cost the entire app.
 *
 * A boundary does not make either mistake less wrong. It decides what a
 * mistake costs: the panel it happened in, rather than everything.
 *
 * Deliberately shows the message. This is an internal tool used by the
 * people who can report it, and "something went wrong" from a colleague
 * is a morning of guessing — the error text and the tab it came from is
 * the whole of the bug report.
 */
export default class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console is where the stack is legible. Left in on purpose:
    // nothing here reaches a logging service, so this is the only trace.
    console.error(`${this.props.name ?? 'Panel'} failed to render`, error, info);
  }

  /*
   * Cleared when the caller says the situation has changed — a different
   * tab, a different contract. Without it a panel that failed once stays
   * failed until the page is reloaded, including after the thing that
   * caused it has been navigated away from.
   */
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="panel boundary">
        <h3>{this.props.name ?? 'This panel'} could not be drawn</h3>
        <p className="caption">
          The rest of the dashboard is unaffected. Reloading may clear it; if it
          comes back, this message is what to report.
        </p>
        <pre className="boundary-error">{String(error?.message ?? error)}</pre>
        <button type="button" className="upload-btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
