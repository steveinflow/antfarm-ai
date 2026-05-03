// @docket/orchestrator — startup recovery.
//
// On boot, any ticket left in 'in_progress' from a previous run is orphaned —
// nothing is actually working on it.  We reset those tickets back to 'open'
// per project so the Firestore listeners pick them up cleanly.

/**
 * @param {object} _state   Unused — recovery is stateless.
 * @param {object} deps
 * @param {object} deps.projects
 * @param {Function} deps.getTicketService
 * @param {Function} deps.writeLogFile
 */
export function createRecovery(_state, deps) {
  const { projects, getTicketService, writeLogFile } = deps;

  async function resetOrphanedTickets() {
    console.log('[orchestrator] Checking for orphaned in_progress tickets...');
    writeLogFile('Checking for orphaned in_progress tickets...');

    for (const [projectId] of Object.entries(projects)) {
      const ticketService = getTicketService(projectId);
      try {
        const count = await ticketService.rekickOrchestrator();
        if (count > 0) {
          console.log(`[orchestrator] Reset ${count} orphaned ticket(s) in ${projectId}`);
          writeLogFile(`Reset ${count} orphaned ticket(s) in ${projectId}`);
        }
      } catch (err) {
        console.error(`[orchestrator] Error resetting tickets in ${projectId}: ${err.message}`);
        writeLogFile(`Error resetting tickets in ${projectId}: ${err.message}`);
      }
    }
  }

  return { resetOrphanedTickets };
}
