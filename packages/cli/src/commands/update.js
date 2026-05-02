// tickets update <ID> — Update a ticket
// Flags: --status, --title, --note, --question, --user, --wip, --critical, --no-critical, --request-upgrade
// Auto-resolves project from ticket prefix via project service.

import {
  createTicketService,
  createProjectService,
  parseTicketId,
} from '@docket/core';

export async function run({ db, admin, config, flags, positional }) {
  // positional[0] = "update", positional[1] = ticket ID (e.g., "KB-005")
  const ticketIdStr = positional[1];
  if (!ticketIdStr) {
    console.error('Usage: tickets update <TICKET-ID> [--status <s>] [--title <t>] [--note <n>] [--question <q>] [--wip <json>] [--critical] [--no-critical]');
    process.exit(1);
  }

  const parsed = parseTicketId(ticketIdStr);
  if (!parsed) {
    console.error(`Invalid ticket ID format: "${ticketIdStr}". Expected format like KB-005.`);
    process.exit(1);
  }

  // Resolve project from prefix
  const projectService = createProjectService(db);
  const project = await projectService.getByPrefix(parsed.prefix);
  if (!project) {
    console.error(`No project found with prefix "${parsed.prefix}".`);
    process.exit(1);
  }

  const ticketService = createTicketService(db, project.id, {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  });

  // Look up the ticket by its number
  const ticket = await ticketService.getByTicketNumber(parsed.number);
  if (!ticket) {
    console.error(`Ticket ${ticketIdStr} not found in project "${project.id}".`);
    process.exit(1);
  }

  let changed = false;

  // Status transition
  if (flags.status) {
    await ticketService.transitionStatus(ticket.id, flags.status, {
      note: flags.note || undefined,
      pendingQuestion: flags.question || undefined,
    });
    changed = true;
    console.log(`${ticketIdStr}: status -> ${flags.status}`);
  }

  // Field updates (title, critical flag, etc.)
  const updates = {};
  if (flags.title) updates.title = flags.title;
  if (flags.user) updates.userId = flags.user;
  // --critical sets critical = true; --no-critical sets critical = false
  if (flags.critical === true || flags.critical === 'true') updates.critical = true;
  if (flags['no-critical'] === true || flags['no-critical'] === 'true') updates.critical = false;

  if (Object.keys(updates).length > 0) {
    await ticketService.update(ticket.id, updates);
    changed = true;
    for (const [key, val] of Object.entries(updates)) {
      console.log(`${ticketIdStr}: ${key} -> ${val}`);
    }
  }

  // WIP (work in progress) save
  if (flags.wip) {
    let wipData;
    try {
      wipData = JSON.parse(flags.wip);
    } catch (err) {
      console.error(`Invalid --wip JSON: ${err.message}`);
      process.exit(1);
    }
    wipData.savedAt = new Date().toISOString();
    await ticketService.update(ticket.id, { workInProgress: wipData });
    changed = true;
    console.log(`${ticketIdStr}: workInProgress saved`);
  }

  // If only --note was passed without --status, add it as a note via update
  if (flags.note && !flags.status) {
    const history = ticket.statusHistory || [];
    history.push({
      to: ticket.status,
      at: new Date().toISOString(),
      note: flags.note,
    });
    await ticketService.update(ticket.id, { statusHistory: history });
    changed = true;
    console.log(`${ticketIdStr}: note added`);
  }

  // Request model upgrade (non-sonnet mode: haiku → opus)
  if (flags['request-upgrade']) {
    const upgradeNote = flags.note || 'Task is too complex for current model — requesting upgrade';
    await ticketService.update(ticket.id, {
      requestUpgrade: true,
      workInProgress: {
        goal: ticket.title,
        upgradeReason: upgradeNote,
        source: 'upgrade-request',
        savedAt: new Date().toISOString(),
      },
    });
    changed = true;
    console.log(`${ticketIdStr}: model upgrade requested — session will restart with Opus`);
  }

  if (!changed) {
    console.log('Nothing to update. Pass --status, --title, --note, --question, --critical, --no-critical, or --request-upgrade.');
  }
}
