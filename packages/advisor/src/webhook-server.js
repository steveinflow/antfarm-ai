// webhook-server.js — DK-136: Event-based persona run triggers
//
// Minimal HTTP server for external webhook triggers (e.g. GitHub/GitLab deploy hooks).
// Requires HMAC-SHA256 signature verification — no "accept all" fallback.
// If DOCKET_WEBHOOK_SECRET is not set, the server does not start.
//
// Rate limit: one run per persona per configurable window (default: 10 min)
// regardless of how many webhook events arrive.
//
// Webhook payloads are used only as a signal — no payload fields are read
// to determine behavior. Raw payloads are never stored.
//
// Log only: persona, trigger type, timestamp.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const WEBHOOK_RATE_LIMIT_MS = Number(process.env.DOCKET_WEBHOOK_RATE_LIMIT_MS) || 10 * 60 * 1000; // 10 min
const WEBHOOK_PORT = Number(process.env.DOCKET_WEBHOOK_PORT) || 7841;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [webhook] ${msg}`);
}

/**
 * Verify HMAC-SHA256 signature from X-Hub-Signature-256 header.
 * Compatible with GitHub, GitLab, and most CI systems.
 *
 * @param {string} secret - HMAC secret
 * @param {Buffer} body   - raw request body
 * @param {string} sigHeader - value of X-Hub-Signature-256 header
 * @returns {boolean}
 */
function verifySignature(secret, body, sigHeader) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  const parts = sigHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  const received = Buffer.from(parts[1], 'hex');
  if (received.length !== 32) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  try {
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

/**
 * Start the webhook server.
 *
 * @param {object} options
 * @param {object} options.db                - Firestore admin instance
 * @param {string[]} options.enabledPersonas - persona IDs to accept webhook triggers for
 * @param {object} [options.rateLimitMs]     - per-persona rate limit in ms (default 10 min)
 * @returns {{ stop: () => void }} - object with a stop() function to close the server
 */
export function startWebhookServer({ db, enabledPersonas }) {
  const secret = process.env.DOCKET_WEBHOOK_SECRET;
  if (!secret) {
    log('DOCKET_WEBHOOK_SECRET not set — webhook server disabled');
    return { stop: () => {} };
  }
  if (!Array.isArray(enabledPersonas) || enabledPersonas.length === 0) {
    log('No personas configured for webhook triggers — webhook server disabled');
    return { stop: () => {} };
  }

  // Per-persona rate limit: timestamp of last webhook-triggered run
  const lastWebhookFired = {}; // personaId -> Date.now()

  const server = createServer((req, res) => {
    // Only POST /webhook
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // Collect body
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);

      // Verify HMAC signature
      const sigHeader = req.headers['x-hub-signature-256'] || req.headers['x-gitlab-token'];
      // GitLab sends the secret directly in X-Gitlab-Token (not HMAC).
      // We support both patterns: if the header is a plain match, treat as GitLab.
      let verified = false;
      if (sigHeader === secret) {
        // GitLab plain token match
        verified = true;
      } else {
        // GitHub-style HMAC
        verified = verifySignature(secret, body, sigHeader || '');
      }

      if (!verified) {
        log(`Webhook signature verification failed — rejecting request`);
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      // Fire for all enabled personas (subject to rate limit)
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      let fired = 0;

      for (const personaId of enabledPersonas) {
        const last = lastWebhookFired[personaId] ?? 0;
        if (now - last < WEBHOOK_RATE_LIMIT_MS) {
          const remainingSec = Math.ceil((WEBHOOK_RATE_LIMIT_MS - (now - last)) / 1000);
          log(`${personaId}: rate limit active — skipping (${remainingSec}s remaining)`);
          continue;
        }

        lastWebhookFired[personaId] = now;
        fired++;

        // Write trigger to Firestore — daemon picks it up via watchRunRequested
        try {
          await db.collection('advisor').doc(personaId).set({
            runRequestedAt: nowIso,
            runRequestedError: null,
          }, { merge: true });

          // Write trigger log entry
          await db.collection('advisorTriggerLog').add({
            personaId,
            trigger: 'webhook',
            triggeredAt: nowIso,
            triggeredBy: 'webhook',
            proposalsCreated: null, // filled in by daemon after run
          });

          log(`${personaId}: webhook trigger fired`);
        } catch (err) {
          log(`${personaId}: failed to write Firestore trigger — ${err.message}`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, triggered: fired }));
    });

    req.on('error', (err) => {
      log(`Request error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    });
  });

  server.listen(WEBHOOK_PORT, () => {
    log(`Webhook server listening on port ${WEBHOOK_PORT}`);
    log(`Enabled personas: ${enabledPersonas.join(', ')}`);
  });

  server.on('error', (err) => {
    log(`Server error: ${err.message}`);
  });

  return {
    stop: () => {
      server.close();
      log('Webhook server stopped');
    },
  };
}
