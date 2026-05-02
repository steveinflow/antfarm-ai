// tickets seed — Seed sample tickets into a project
// Flags: --project, --user

import {
  createTicketService,
} from '@docket/core';

const SAMPLE_TICKETS = [
  {
    type: 'bug',
    title: 'Login page returns 500 on invalid email format',
    description: 'Entering an email without @ symbol causes an unhandled server error instead of a validation message.',
  },
  {
    type: 'feature',
    title: 'Add dark mode toggle to settings',
    description: 'Users have requested a dark mode option. Should persist preference across sessions.',
  },
  {
    type: 'bug',
    title: 'Sidebar collapses on window resize below 1024px',
    description: 'The sidebar disappears entirely instead of switching to a compact view when the viewport is narrow.',
  },
  {
    type: 'feature',
    title: 'Export tickets to CSV',
    description: 'Allow project admins to download a CSV of all tickets with filters for status and date range.',
  },
  {
    type: 'bug',
    title: 'Notification badge count does not decrement after reading',
    description: 'The unread count in the top nav stays stale until a full page reload.',
  },
  {
    type: 'feature',
    title: 'Webhook integration for Slack notifications',
    description: 'Send a Slack message when a ticket transitions to done or waiting_for_user.',
  },
];

export async function run({ db, admin, config, flags }) {
  const projectId = flags.project || config.project;
  if (!projectId) {
    console.error('Error: --project is required (or set defaults.project in config).');
    process.exit(1);
  }

  const userId = flags.user || config.userId || 'cli-seed';

  const ticketService = createTicketService(db, projectId, {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`Seeding ${SAMPLE_TICKETS.length} tickets into project "${projectId}"...`);

  for (const sample of SAMPLE_TICKETS) {
    const ticket = await ticketService.add({
      ...sample,
      userId,
    });
    console.log(`  ${ticket.ticketId}: ${ticket.title}`);
  }

  console.log('Done.');
}
