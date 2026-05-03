// @docket/orchestrator — TUI / classic-dashboard keyboard handler.
//
// The orchestrator runs in a TTY by default and exposes a small set of
// global keys (q, r, t, d) plus per-view keys forwarded by tui/dashboard
// (rekick, maintenance, pool_up, pool_down, quit).  This module wires the
// raw stdin handler — it touches a lot of other concerns
// (shutdown / resetOrphanedTickets / runScheduledMaintenance / dequeueNext /
//  config sync) so the deps list is wide.

/**
 * @param {object} state    Shared orchestrator state.
 * @param {object} deps
 * @param {object}   deps.db
 * @param {object}   deps.tui
 * @param {object}   deps.dashboard
 * @param {Function} deps.shutdown
 * @param {Function} deps.resetOrphanedTickets
 * @param {Function} deps.runScheduledMaintenance
 * @param {Function} deps.dequeueNext
 * @param {Function} deps.writeLogFile
 */
export function createKeyboardHandler(state, deps) {
  const { config } = state;
  const {
    db,
    tui,
    dashboard,
    shutdown,
    resetOrphanedTickets,
    runScheduledMaintenance,
    dequeueNext,
    writeLogFile,
  } = deps;

  function syncMaxWorkersToFirestore() {
    db.collection('orchestrator').doc('config').set(
      { maxWorkers: config.maxWorkers },
      { merge: true }
    ).catch(err => writeLogFile(`Failed to sync pool size: ${err.message}`));
  }

  function triggerManualMaintenance() {
    if (state.maintenanceRunning) {
      writeLogFile('Maintenance already running — ignoring manual trigger');
      return;
    }
    writeLogFile('Manual maintenance triggered via keyboard');
    // Cancel the scheduled timer so we don't double-run
    if (state.maintenanceTimer) {
      clearTimeout(state.maintenanceTimer);
      state.maintenanceTimer = null;
    }
    runScheduledMaintenance().catch(err => {
      writeLogFile(`Manual maintenance error: ${err.stack || err.message}`);
    });
  }

  function startKeyboardHandler() {
    if (!process.stdin.isTTY) return;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', async (key) => {
      // Classic dashboard is open — delegate (overrides TUI)
      if (dashboard.isOpen) {
        const result = dashboard.handleKey(key);
        if (result === 'quit') {
          await shutdown();
          process.exit(0);
        }
        if (result === 'rekick') {
          await resetOrphanedTickets();
          dashboard.render();
        }
        if (result === 'maintenance') {
          triggerManualMaintenance();
          dashboard.render();
        }
        if (result === 'pool_up') {
          config.maxWorkers++;
          writeLogFile(`Max workers increased to ${config.maxWorkers}`);
          dashboard.render();
          dequeueNext();
          syncMaxWorkersToFirestore();
        }
        if (result === 'pool_down') {
          config.maxWorkers = Math.max(1, config.maxWorkers - 1);
          writeLogFile(`Max workers decreased to ${config.maxWorkers}`);
          dashboard.render();
          syncMaxWorkersToFirestore();
        }
        // If classic dashboard closed itself (ESC), return to TUI
        if (!dashboard.isOpen && result !== 'quit') {
          tui.open();
        }
        return;
      }

      // Fancy TUI is open — delegate
      if (tui.isOpen) {
        // 'd' opens classic dashboard (TUI closes itself via ESC / its own quit)
        if (key === 'd') {
          tui.close();
          dashboard.open();
          return;
        }
        const result = tui.handleKey(key);
        if (result === 'quit') {
          await shutdown();
          process.exit(0);
        }
        if (result === 'rekick') {
          await resetOrphanedTickets();
          tui.render();
        }
        if (result === 'maintenance') {
          triggerManualMaintenance();
          tui.render();
        }
        if (result === 'pool_up') {
          config.maxWorkers++;
          writeLogFile(`Max workers increased to ${config.maxWorkers}`);
          tui.render();
          dequeueNext();
          syncMaxWorkersToFirestore();
        }
        if (result === 'pool_down') {
          config.maxWorkers = Math.max(1, config.maxWorkers - 1);
          writeLogFile(`Max workers decreased to ${config.maxWorkers}`);
          tui.render();
          syncMaxWorkersToFirestore();
        }
        return;
      }

      // Both UIs closed — global shortcuts
      switch (key) {
        case 't':
          tui.open();
          break;
        case 'd':
          dashboard.open();
          break;
        case 'q':
        case '\x03': // Ctrl+C
          await shutdown();
          process.exit(0);
          break;
        case 'r':
          await resetOrphanedTickets();
          break;
        default:
          break;
      }
    });
  }

  return { startKeyboardHandler };
}
