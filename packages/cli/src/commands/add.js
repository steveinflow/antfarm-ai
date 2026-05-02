// tickets add — Add a ticket
// Flags: --project, --type, --title, --description, --user

import {
  createTicketService,
  validateTicket,
} from '@docket/core';

export async function run({ db, admin, config, flags }) {
  const projectId = flags.project || config.project;
  if (!projectId) {
    console.error('Error: --project is required (or set defaults.project in config).');
    process.exit(1);
  }

  const type = flags.type;
  const title = flags.title;
  const description = flags.description || '';
  const userId = flags.user || config.userId || null;

  // Validate
  const errors = validateTicket({ type, title });
  if (errors) {
    console.error('Validation errors:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  const ticketService = createTicketService(db, projectId, {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  });

  const ticket = await ticketService.add({
    type,
    title,
    description,
    userId,
  });

  if (flags.json) {
    console.log(JSON.stringify(ticket, null, 2));
  } else {
    console.log(`Created ticket ${ticket.ticketId}: ${ticket.title}`);
  }
}
