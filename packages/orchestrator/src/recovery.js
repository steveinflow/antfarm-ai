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
    writeLogFile('Checking for orphaned in_progress tickets...');

    for (const [projectId] of Object.entries(projects)) {
      const ticketService = getTicketService(projectId);
      try {
        const count = await ticketService.rekickOrchestrator();
        if (count > 0) {
          writeLogFile(`Reset ${count} orphaned ticket(s) in ${projectId}`);
        }
      } catch (err) {
        writeLogFile(`Error resetting tickets in ${projectId}: ${err.message}`);
      }
    }
  }

  return { resetOrphanedTickets };
}
