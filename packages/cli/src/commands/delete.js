// tickets delete <ID> — Delete a ticket permanently
// Flags: --force (skip confirmation prompt)

import {
  createTicketService,
  createProjectService,
  parseTicketId,
} from '@docket/core';
import { createInterface } from 'node:readline';

export async function run({ db, admin, config, flags, positional }) {
  // positional[0] = "delete", positional[1] = ticket ID (e.g., "KB-005")
  const ticketIdStr = positional[1];
  if (!ticketIdStr) {
    console.error('Usage: docket delete <TICKET-ID> [--force]');
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

  // Confirm deletion unless --force flag is passed
  if (!flags.force) {
    const confirmed = await confirm(
      `Delete ticket ${ticketIdStr}: "${ticket.title}"? This cannot be undone. [y/N] `
    );
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  await ticketService.deleteTicket(ticket.id);
  console.log(`Deleted ticket ${ticketIdStr}.`);
}

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
