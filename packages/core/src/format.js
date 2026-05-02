// Ticket ID formatting and parsing

export function formatTicketNumber(prefix, num) {
  return `${prefix}-${String(num).padStart(3, '0')}`;
}

export function parseTicketId(str) {
  const m = str.match(/^([A-Z]{2,4})-(\d+)$/i);
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), number: parseInt(m[2], 10) };
}
