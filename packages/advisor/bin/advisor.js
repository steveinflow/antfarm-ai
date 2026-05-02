#!/usr/bin/env node

// @docket/advisor — EPD Advisor daemon
// Runs Product, Design, and Engineer personas on configurable timers.
// Each cycle discovers all Firestore projects that have an advisorContext set
// and runs the relevant persona against every one of them.
// Writes persona state to Firestore (/advisor/{personaId}) so the web UI
// can show live status and send back controls (pause, interval change).
//
// Usage: docket-advisor --config ./docket.config.json

import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { createTicketService, createProjectService } from '@docket/core';
import { createEngineer } from '../src/engineer.js';
import { createDesigner } from '../src/design.js';
import { createProductManager } from '../src/product.js';
import { createPersonaState } from '../src/state.js';
import { loadCustomPersonas } from '../src/custom-personas-config.js';
import { createCustomPersona } from '../src/custom-persona.js';
import { writeRunLog } from '../src/write-run-log.js';
import { sanitizeError } from '../src/run-logger.js';
import { validateConsensusGate, runEndorsementStep } from '../src/consensus.js';

// ── Argument parsing ─────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    }
    i++;
  }
  return flags;
}

function log(persona, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${persona}] ${msg}`);
}

// ── Persona loop ─────────────────────────────────────────────────
// Uses setTimeout (not setInterval) so the next cycle is always scheduled
// AFTER the current one completes. Reads intervalHours from Firestore each
// time so UI-driven changes take effect on the next cycle.

function startPersonaLoop(name, defaultIntervalHours, runFn, personaState) {
  let stopped = false;
  let totalTickets = 0;
  let cycleCount = 0;
  let pendingTimer = null;
  let isRunning = false;
  let runNowPending = false;

  // Cancel the pending sleep timer and run a cycle now.
  // If already running, schedule an immediate follow-up cycle.
  function triggerNow() {
    if (stopped) return;
    if (isRunning) {
      // Already running — schedule an immediate follow-up after this cycle ends
      log(name, 'Run-now triggered while running — will run again immediately after');
      runNowPending = true;
      return;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
      log(name, 'Run-now triggered — starting cycle early');
      tick();
    }
  }

  // Watch for runNow flag from the web UI.
  const unsubRunNow = personaState.watchRunNow(() => {
    log(name, 'runNow flag detected');
    triggerNow();
  });

  async function tick() {
    if (stopped) return;

    isRunning = false; // reset before reading state (set true once we start work)

    // Read current state from Firestore (may have been updated by UI)
    const state = await personaState.read();
    const intervalHours = state?.intervalHours ?? defaultIntervalHours;
    const intervalMs = intervalHours * 3_600_000;
    const paused = state?.status === 'paused';

    // If runNow was set, clear it so UI button re-enables.
    if (state?.runNow) {
      await personaState.clearRunNow();
    }

    if (paused) {
      log(name, 'Paused — skipping cycle');
      pendingTimer = setTimeout(tick, intervalMs);
      return;
    }

    isRunning = true;

    // Update accumulated stats from stored state
    totalTickets = state?.ticketsCreated ?? totalTickets;
    cycleCount   = state?.cycleCount    ?? cycleCount;

    await personaState.setRunning('Starting cycle…');
    log(name, 'Cycle starting');

    // Callback that each persona calls to report live progress.
    // Writes to Firestore so the web UI shows real-time activity.
    const onActivity = (msg) => {
      personaState.setRunning(msg).catch(() => {}); // fire-and-forget
    };

    let result = { ticketsCreated: 0, lastActivity: 'Cycle completed' };
    let error = null;

    try {
      result = await runFn(onActivity) ?? result;
    } catch (err) {
      error = err.message || String(err);
      result.lastActivity = `Error: ${error}`;
      log(name, `Cycle failed: ${error}`);
      if (process.env.DEBUG) console.error(err);
    }

    isRunning = false;
    totalTickets += result.ticketsCreated;
    cycleCount   += 1;

    const nextRunAt = new Date(Date.now() + intervalMs);
    await personaState.setIdle({
      lastActivity:   result.lastActivity,
      ticketsCreated: totalTickets,
      cycleCount,
      nextRunAt,
      error,
    });

    if (runNowPending) {
      runNowPending = false;
      log(name, `Cycle done. runNow pending — starting next cycle immediately`);
      pendingTimer = setTimeout(tick, 0);
    } else {
      log(name, `Cycle done. Next in ${intervalHours}h`);
      pendingTimer = setTimeout(tick, intervalMs);
    }
  }

  tick(); // run immediately on start
  return () => {
    stopped = true;
    unsubRunNow();
    if (pendingTimer !== null) clearTimeout(pendingTimer);
  };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(`
Usage: docket-advisor --config <path>

Options:
  --config <path>   Path to docket.config.json (required)
  --help            Show this help

Config shape (add "advisor" key to docket.config.json):

  "advisor": {
    "product": {
      "intervalHours": 24,
      "reviewGate": false,
      "model": "claude-opus-4-6"
    },
    "design": {
      "intervalHours": 6,
      "reviewGate": false,
      "model": "claude-sonnet-4-6",
      "cookies": [],
      "localStorage": {}
    },
    "engineer": {
      "intervalHours": 12,
      "reviewGate": false,
      "model": "claude-haiku-4-5-20251001"
    },
    "projects": {
      "<projectId>": {
        "appUrl": "https://your-app.web.app",
        "appFlows": ["/", "/dashboard"],
        "repoPath": "/path/to/repo",
        "scanPaths": ["src", "packages/*/src"]
      }
    }
  }

Each project's advisorContext is set via the web UI (or by updating
the Firestore /projects/{id} doc directly). Personas only run against
projects that have a non-empty advisorContext.
`.trim());
    process.exit(0);
  }

  // ── Load config ──────────────────────────────────────────────
  const configPath = flags.config;
  if (!configPath) {
    console.error('Error: --config <path> is required.');
    process.exit(1);
  }

  const resolvedConfigPath = resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    console.error(`Error: config file not found: ${resolvedConfigPath}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(resolvedConfigPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse config: ${err.message}`);
    process.exit(1);
  }

  const advisorConfig = config.advisor;
  if (!advisorConfig) {
    console.error('Error: no "advisor" key found in config. See --help for shape.');
    process.exit(1);
  }

  const configDir = dirname(resolvedConfigPath);

  // ── Firebase init ────────────────────────────────────────────
  let keyPath = process.env.DOCKET_FIREBASE_KEY_PATH;
  if (!keyPath && config.firebaseKeyPath) keyPath = resolve(configDir, config.firebaseKeyPath);
  if (!keyPath) {
    const candidate = resolve(configDir, 'serviceAccountKey.json');
    if (existsSync(candidate)) keyPath = candidate;
  }
  if (!keyPath || !existsSync(keyPath)) {
    console.error('Error: Firebase service account key not found.');
    process.exit(1);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
  const makeTicketService = (projectId) =>
    createTicketService(db, projectId, { serverTimestamp });

  const projectService = createProjectService(db);
  const projectsCfg = advisorConfig.projects || {}; // per-project infra settings

  // ── Consensus gate (DK-194) ───────────────────────────────────
  // Read from both config file (initial value) and Firestore (live toggle).
  // Validated at startup. If invalid, disabled with a warning rather than crashing.
  // Firestore path: /advisor/consensusGate — mirrors the pause toggle pattern.
  let consensusGateCfg = advisorConfig.consensusGate || null;

  // Helper: get enabled persona IDs from config (for threshold validation)
  function getEnabledPersonaIds() {
    const ids = [];
    if (advisorConfig.engineer) ids.push('engineer');
    if (advisorConfig.design) ids.push('design');
    if (advisorConfig.product) ids.push('product');
    return ids;
  }

  // Helper: read consensus gate config from Firestore (live toggle).
  // Falls back to config file value if Firestore doc is absent.
  async function readConsensusGate() {
    try {
      const snap = await db.collection('advisor').doc('consensusGate').get();
      if (snap.exists) {
        const data = snap.data();
        return {
          enabled: !!data.enabled,
          threshold: typeof data.threshold === 'number' ? data.threshold : (consensusGateCfg?.threshold ?? 2),
          maxProposedTickets: typeof data.maxProposedTickets === 'number' ? data.maxProposedTickets : (consensusGateCfg?.maxProposedTickets ?? 5),
        };
      }
    } catch {
      // Firestore unavailable — fall through to config file value
    }
    return consensusGateCfg;
  }

  // Validate at startup
  if (consensusGateCfg?.enabled) {
    const enabledPersonas = getEnabledPersonaIds();
    const { valid, warning } = validateConsensusGate(consensusGateCfg, enabledPersonas);
    if (!valid) {
      if (warning) console.warn(`[advisor] Warning: ${warning}`);
      consensusGateCfg = { ...consensusGateCfg, enabled: false };
    } else {
      log('advisor', `Consensus gate ENABLED — threshold: ${consensusGateCfg.threshold} of ${enabledPersonas.length} personas`);
    }
  }

  const stoppers = [];
  let personaCount = 0;

  // ── Engineer ─────────────────────────────────────────────────
  if (advisorConfig.engineer) {
    const cfg = advisorConfig.engineer;
    const hours = cfg.intervalHours || 12;
    const runRetention = advisorConfig.runRetention ?? 20;
    const engineer = createEngineer({ config: cfg });
    const state = createPersonaState(db, 'engineer');
    await state.init(hours);
    log('engineer', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('engineer', hours, async (onActivity) => {
      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) log('engineer', 'Using custom soul prompt from Firestore');

      // DK-194: Read live consensus gate config (may have changed via Firestore toggle)
      const liveConsensusGate = await readConsensusGate();
      const enabledPersonas = getEnabledPersonaIds();
      const { valid: gateValid } = validateConsensusGate(liveConsensusGate, enabledPersonas);
      const activeGate = gateValid ? liveConsensusGate : null;

      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim());
      log('engineer', `Found ${eligible.length} project(s) with advisorContext`);

      // DK-194: Run endorsement step for each eligible project before generating new tickets.
      // Each persona evaluates proposed tickets from other personas, capped at maxProposedTickets.
      if (activeGate?.enabled) {
        for (const project of eligible) {
          try {
            const endorseResult = await runEndorsementStep({
              personaName: 'engineer',
              db,
              projectId: project.id,
              model: cfg.model || 'claude-haiku-4-5-20251001',
              allPersonas: enabledPersonas,
              maxProposedTickets: activeGate.maxProposedTickets ?? 5,
              log: (msg) => log('engineer', msg),
            });
            if (endorseResult.evaluated > 0) {
              onActivity(`${project.id}: endorsed ${endorseResult.evaluated} ticket(s) (promoted: ${endorseResult.promoted}, rejected: ${endorseResult.rejected})`);
            }
          } catch (err) {
            log('engineer', `[${project.id}] Endorsement step failed: ${err.message}`);
          }
        }
      }

      let totalTickets = 0;
      const activities = [];

      for (const project of eligible) {
        const pCfg = projectsCfg[project.id] || {};
        const repoPath = pCfg.repoPath || project.repoPath;
        // scanPaths resolution order: config file → Firestore project doc → scan repo root
        const scanPaths = pCfg.scanPaths || project.scanPaths || ['.'];

        if (!repoPath) {
          log('engineer', `[${project.id}] No repoPath configured — skipping`);
          activities.push(`${project.id}: no repoPath`);
          continue;
        }

        const ticketService = makeTicketService(project.id);
        const cycleStart = new Date();
        let result = { ticketsCreated: 0, filesScanned: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: '' };
        let cycleError = null;
        try {
          result = await engineer.runAudit({ project, repoPath, scanPaths, ticketService, db, onActivity, soulPrompt, consensusGate: activeGate });
        } catch (err) {
          cycleError = sanitizeError(err);
          result.lastActivity = `${project.id}: error`;
          log('engineer', `[${project.id}] Cycle error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        }
        totalTickets += result.ticketsCreated;
        activities.push(result.lastActivity);
        await writeRunLog(db, 'engineer', project.id, {
          startedAt: cycleStart,
          filesScanned: result.filesScanned || 0,
          tokensUsed: 0,
          proposalsCreated: result.ticketsCreated || 0,
          proposalsSkipped: result.proposalsSkipped || 0,
          skippedReasons: result.skippedReasons || [],
          error: cycleError,
        }, runRetention);
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── Design ───────────────────────────────────────────────────
  if (advisorConfig.design) {
    const cfg = advisorConfig.design;
    const hours = cfg.intervalHours || 6;
    const runRetention = advisorConfig.runRetention ?? 20;
    const designer = createDesigner({ config: cfg });
    const state = createPersonaState(db, 'design');
    await state.init(hours);
    log('design', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('design', hours, async (onActivity) => {
      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) log('design', 'Using custom soul prompt from Firestore');

      // DK-194: Read live consensus gate config
      const liveConsensusGate = await readConsensusGate();
      const enabledPersonas = getEnabledPersonaIds();
      const { valid: gateValid } = validateConsensusGate(liveConsensusGate, enabledPersonas);
      const activeGate = gateValid ? liveConsensusGate : null;

      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim());
      log('design', `Found ${eligible.length} project(s) with advisorContext`);

      // DK-194: Run endorsement step for each eligible project before generating new tickets.
      if (activeGate?.enabled) {
        for (const project of eligible) {
          try {
            const endorseResult = await runEndorsementStep({
              personaName: 'design',
              db,
              projectId: project.id,
              model: cfg.model || 'claude-sonnet-4-6',
              allPersonas: enabledPersonas,
              maxProposedTickets: activeGate.maxProposedTickets ?? 5,
              log: (msg) => log('design', msg),
            });
            if (endorseResult.evaluated > 0) {
              onActivity(`${project.id}: endorsed ${endorseResult.evaluated} ticket(s) (promoted: ${endorseResult.promoted}, rejected: ${endorseResult.rejected})`);
            }
          } catch (err) {
            log('design', `[${project.id}] Endorsement step failed: ${err.message}`);
          }
        }
      }

      let totalTickets = 0;
      const activities = [];

      for (const project of eligible) {
        const pCfg = projectsCfg[project.id] || {};
        const appUrl = pCfg.appUrl;
        const flows = pCfg.appFlows || ['/'];

        const ticketService = makeTicketService(project.id);
        const cycleStart = new Date();
        let result = { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: '' };
        let cycleError = null;
        try {
          result = await designer.runAudit({ project, appUrl, flows, ticketService, db, onActivity, soulPrompt, consensusGate: activeGate });
        } catch (err) {
          cycleError = sanitizeError(err);
          result.lastActivity = `${project.id}: error`;
          log('design', `[${project.id}] Cycle error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        }
        totalTickets += result.ticketsCreated;
        activities.push(result.lastActivity);
        await writeRunLog(db, 'design', project.id, {
          startedAt: cycleStart,
          filesScanned: 0,
          tokensUsed: 0,
          proposalsCreated: result.ticketsCreated || 0,
          proposalsSkipped: result.proposalsSkipped || 0,
          skippedReasons: result.skippedReasons || [],
          error: cycleError,
        }, runRetention);
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── Product ──────────────────────────────────────────────────
  if (advisorConfig.product) {
    const cfg = advisorConfig.product;
    const hours = cfg.intervalHours || 24;
    const runRetention = advisorConfig.runRetention ?? 20;
    const pm = createProductManager({ config: cfg });
    const state = createPersonaState(db, 'product');
    await state.init(hours);
    log('product', `Starting — interval ${hours}h`);

    stoppers.push(startPersonaLoop('product', hours, async (onActivity) => {
      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) log('product', 'Using custom soul prompt from Firestore');

      // DK-194: Read live consensus gate config
      const liveConsensusGate = await readConsensusGate();
      const enabledPersonas = getEnabledPersonaIds();
      const { valid: gateValid } = validateConsensusGate(liveConsensusGate, enabledPersonas);
      const activeGate = gateValid ? liveConsensusGate : null;

      const projects = await projectService.list();
      const eligible = projects.filter(p => p.advisorContext?.trim());
      log('product', `Found ${eligible.length} project(s) with advisorContext`);

      // DK-194: Run endorsement step for each eligible project before generating new tickets.
      if (activeGate?.enabled) {
        for (const project of eligible) {
          try {
            const endorseResult = await runEndorsementStep({
              personaName: 'product',
              db,
              projectId: project.id,
              model: cfg.model || 'claude-sonnet-4-6',
              allPersonas: enabledPersonas,
              maxProposedTickets: activeGate.maxProposedTickets ?? 5,
              log: (msg) => log('product', msg),
            });
            if (endorseResult.evaluated > 0) {
              onActivity(`${project.id}: endorsed ${endorseResult.evaluated} ticket(s) (promoted: ${endorseResult.promoted}, rejected: ${endorseResult.rejected})`);
            }
          } catch (err) {
            log('product', `[${project.id}] Endorsement step failed: ${err.message}`);
          }
        }
      }

      let totalTickets = 0;
      const activities = [];

      for (const project of eligible) {
        const cycleStart = new Date();
        const ticketService = makeTicketService(project.id);
        let result = { ticketsCreated: 0, proposalsSkipped: 0, skippedReasons: [], lastActivity: '' };
        let cycleError = null;
        try {
          result = await pm.runCycle({ project, ticketService, db, onActivity, soulPrompt, consensusGate: activeGate });
        } catch (err) {
          cycleError = sanitizeError(err);
          log('product', `[${project.id}] Run error: ${err.message}`);
          if (process.env.DEBUG) console.error(err);
        }
        await writeRunLog(db, 'product', project.id, {
          startedAt: cycleStart,
          filesScanned: 0,
          tokensUsed: 0,
          proposalsCreated: result.ticketsCreated || 0,
          proposalsSkipped: result.proposalsSkipped || 0,
          skippedReasons: result.skippedReasons || [],
          error: cycleError,
        }, runRetention);
        totalTickets += result.ticketsCreated || 0;
        activities.push(result.lastActivity || `${project.id}: done`);
      }

      return {
        ticketsCreated: totalTickets,
        lastActivity: activities.length > 0 ? activities.join(' | ') : 'No eligible projects',
      };
    }, state));
    personaCount++;
  }

  // ── Custom personas (from docket.config.json) ────────────────
  const { personas: configPersonas, warnings } = loadCustomPersonas(advisorConfig);
  for (const warning of warnings) {
    console.warn(`[advisor] Warning: ${warning}`);
  }

  // Track running custom persona loops by id
  const customPersonaStoppers = {};

  async function startCustomPersonaLoop(personaCfg) {
    if (customPersonaStoppers[personaCfg.id]) return;
    const hours = personaCfg.intervalHours;
    const runner = createCustomPersona(personaCfg);
    const state = createPersonaState(db, personaCfg.id);
    await state.init(hours);
    log(personaCfg.id, `Starting custom persona "${personaCfg.name}" — interval ${hours}h`);

    const stop = startPersonaLoop(personaCfg.id, hours, async (onActivity) => {
      const soulPrompt = await state.getSoulPrompt();
      if (soulPrompt) log(personaCfg.id, 'Using custom soul prompt from Firestore');

      return runner.runCycle({
        db,
        projectService,
        makeTicketService,
        onActivity,
        soulPrompt,
      });
    }, state);

    customPersonaStoppers[personaCfg.id] = stop;
    stoppers.push(stop);
  }

  for (const personaCfg of configPersonas) {
    await startCustomPersonaLoop(personaCfg);
    personaCount++;
  }

  // ── Watch Firestore /advisorPersonas for dynamic personas ─────
  const { validatePersona } = await import('../src/custom-personas-config.js');

  const firestorePersonasUnsub = db.collection('advisorPersonas').onSnapshot(
    async (snap) => {
      for (const docChange of snap.docChanges()) {
        const data = docChange.doc.data();
        if (docChange.type === 'added' || docChange.type === 'modified') {
          if (customPersonaStoppers[data.id]) continue;
          const { persona, errors } = validatePersona(data);
          if (errors.length > 0) {
            log('advisor', `Custom persona "${data.name || data.id}" skipped: ${errors.join('; ')}`);
            continue;
          }
          try {
            await startCustomPersonaLoop(persona);
            personaCount++;
          } catch (err) {
            log('advisor', `Failed to start custom persona "${persona.name}": ${err.message}`);
          }
        }
      }
    },
    (err) => {
      log('advisor', `Warning: could not watch /advisorPersonas — ${err.message}`);
    }
  );
  stoppers.push(() => firestorePersonasUnsub());

  if (personaCount === 0) {
    console.error('Error: no personas configured. Add "engineer", "design", and/or "product" under "advisor".');
    process.exit(1);
  }

  console.log(`EPD Advisor running with ${personaCount} persona(s). Press Ctrl+C to stop.`);

  // ── Graceful shutdown ────────────────────────────────────────
  const shutdown = () => {
    console.log('\nShutting down…');
    for (const stop of stoppers) stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
