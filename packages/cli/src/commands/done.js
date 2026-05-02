// tickets done <ID> — Shortcut for update --status done
// Flags: --note, --user

import {
  createTicketService,
  createProjectService,
  parseTicketId,
} from '@docket/core';

export async function run({ db, admin, config, flags, positional }) {
  // positional[0] = "done", positional[1] = ticket ID (e.g., "KB-005")
  const ticketIdStr = positional[1];
  if (!ticketIdStr) {
    console.error('Usage: tickets done <TICKET-ID> [--note <n>]');
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

  const ticket = await ticketService.getByTicketNumber(parsed.number);
  if (!ticket) {
    console.error(`Ticket ${ticketIdStr} not found in project "${project.id}".`);
    process.exit(1);
  }

  await ticketService.transitionStatus(ticket.id, 'done', {
    note: flags.note || 'Marked done via CLI',
  });

  console.log(`${ticketIdStr}: status -> done`);
}
