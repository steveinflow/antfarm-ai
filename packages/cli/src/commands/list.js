// tickets list — List tickets
// Flags: --project, --status, --json, --user

import {
  createTicketService,
  createProjectService,
  statusLabel,
  formatTicketNumber,
} from '@docket/core';

export async function run({ db, admin, config, flags }) {
  const projectId = flags.project || config.project;
  if (!projectId) {
    console.error('Error: --project is required (or set defaults.project in config).');
    process.exit(1);
  }

  const ticketService = createTicketService(db, projectId, {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
  });

  const filterStatus = flags.status || undefined;
  const filterUser = flags.user || config.userId || undefined;

  // Build query filters
  const queryOpts = {};
  if (filterStatus) queryOpts.status = filterStatus;
  // Only filter by user if --user was explicitly passed (not the config default)
  if (flags.user) queryOpts.userId = flags.user;

  const tickets = await ticketService.list(queryOpts);

  // JSON output
  if (flags.json) {
    console.log(JSON.stringify(tickets, null, 2));
    return;
  }

  // Table output
  if (tickets.length === 0) {
    console.log('No tickets found.');
    return;
  }

  // Header
  const cols = [
    pad('ID', 10),
    pad('Status', 18),
    pad('Type', 8),
    'Title',
  ];
  console.log(cols.join('  '));
  console.log('-'.repeat(72));

  for (const t of tickets) {
    const row = [
      pad(t.ticketId, 10),
      pad(statusLabel(t.status), 18),
      pad(t.type || '-', 8),
      t.title,
    ];
    console.log(row.join('  '));
  }

  console.log(`\n${tickets.length} ticket(s)`);
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
