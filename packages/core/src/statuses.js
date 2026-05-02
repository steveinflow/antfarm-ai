// Ticket status constants and transitions

export const STATUSES = {
  PROPOSED: 'proposed',
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  BLOCKED: 'blocked',
  IN_MAINTENANCE: 'in_maintenance',
  WAITING_FOR_USER: 'waiting_for_user',
  DONE: 'done',
  VERIFIED: 'verified',
  WONT_DO: 'wont_do',
  REJECTED: 'rejected',
  DISMISSED: 'dismissed',
};

export const STATUS_LABELS = {
  proposed: 'Proposed',
  open: 'Open',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  in_maintenance: 'In Maintenance',
  waiting_for_user: 'Needs Your Input',
  done: 'Done',
  verified: 'Verified',
  wont_do: "Won't Do",
  rejected: 'Rejected',
  dismissed: 'Dismissed',
};

export const VALID_TRANSITIONS = {
  proposed:         ['open', 'wont_do', 'rejected', 'dismissed'],
  open:             ['in_progress'],
  in_progress:      ['open', 'blocked', 'waiting_for_user', 'done'],
  blocked:          ['open', 'in_progress', 'in_maintenance'],
  in_maintenance:   ['done', 'blocked', 'open'],
  waiting_for_user: ['in_progress', 'open'],
  done:             ['open', 'in_progress', 'verified'],
  verified:         ['open'],
  wont_do:          ['open'],
  rejected:         ['open'],
  dismissed:        ['open'],
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}
