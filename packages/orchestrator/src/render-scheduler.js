// @docket/orchestrator — debounced render scheduler.
//
// Coalesces rapid state changes into a single TUI / dashboard repaint at
// most every 100 ms, so a burst of Firestore snapshots or worker log lines
// doesn't redraw the terminal once per event.

/**
 * @param {object} state    Shared orchestrator state (uses state.renderTimer).
 * @param {object} deps
 * @param {object} deps.tui       TUI view with isOpen / render().
 * @param {object} deps.dashboard Classic dashboard view with isOpen / render().
 */
export function createRenderScheduler(state, deps) {
  const { tui, dashboard } = deps;

  function scheduleRender() {
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => {
      state.renderTimer = null;
      if (tui.isOpen) tui.render();
      else if (dashboard.isOpen) dashboard.render();
    }, 100);
  }

  return { scheduleRender };
}
