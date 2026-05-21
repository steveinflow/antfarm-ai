// @docket/orchestrator — Firestore subscription wiring.
//
// All of the orchestrator's "react to a Firestore change" logic lives here.
// There are four subscriptions:
//   1. /orchestrator/config — live pool size, sonnetPaused toggle, kill
//      signal, manual maintenance trigger, canary promotion requests.
//   2. /orchestrator/maintenance — maintenance worker status (for the TUI).
//   3. /advisor/<personaId> — advisor persona state (for the TUI).
//   4. /projects/<projectId> + per-project ticket subcollections — open,
//      blocked, critical, paused (waiting_for_user) tickets.
//
// The factory returns a single `attach()` that wires everything in and
// pushes its unsubscribe handles into state.listenerUnsubs.

import {
  startProjectListener,
  startBlockedTicketListener,
  startPausedTicketsListener,
  startCriticalTicketListener,
} from './listener.js';
import { promoteCanary } from './deploy.js';

/**
 * @param {object} state
 * @param {object} deps
 * @param {object}   deps.db
 * @param {object}   deps.projects
 * @param {string}   deps.userId
 * @param {string}   deps.fallbackModel
 * @param {string}   deps.model
 * @param {Function} deps.writeLogFile
 * @param {Function} deps.scheduleRender
 * @param {Function} deps.dequeueNext
 * @param {Function} deps.shutdown
 * @param {Function} deps.runScheduledMaintenance
 * @param {Function} deps.handleNewTicket
 * @param {Function} deps.handleCriticalUpgrade
 * @param {Function} deps.handleBlockedTicket
 * @param {Function} deps.handleResume
 * @param {Function} deps.ensureProjectRepo
 * @param {Function} deps.bootstrapNewProject
 */
export function createFirestoreListeners(state, deps) {
  const {
    listenerUnsubs,
    registeredProjectIds,
    pausedWorkers,
    advisorPersonaState,
    lastSeenPromoteCanary,
    config,
    upgradeModel,
    MAX_WORKERS_LIMIT,
  } = state;
  const {
    db,
    projects,
    userId,
    fallbackModel,
    model,
    writeLogFile,
    scheduleRender,
    dequeueNext,
    shutdown,
    runScheduledMaintenance,
    handleNewTicket,
    handleCriticalUpgrade,
    handleBlockedTicket,
    handleResume,
    ensureProjectRepo,
    bootstrapNewProject,
  } = deps;

  /**
   * Register all four Firestore listeners (open, blocked, critical, paused) for
   * a single project.  Safe to call multiple times — skips projects that are
   * already registered.
   *
   * Also ensures `projects[projectId]` exists so that workers can look up the
   * projectConfig.  For projects added dynamically through the web UI the
   * repoPath is often empty; the config entry is still created so the rest of
   * the orchestrator code doesn't crash when it accesses `projects[projectId]`.
   */
  function registerProjectListeners(projectId, projectConfig) {
    if (registeredProjectIds.has(projectId)) return;
    registeredProjectIds.add(projectId);

    // Ensure the projects map has an entry for this project so that
    // claimAndSpawn / doSpawnWorker / maintenance can look up projectConfig.
    if (!projects[projectId]) {
      projects[projectId] = projectConfig || {};
    }

    const unsub = startProjectListener(db, projectId, userId, {
      onNewTicket: (docId, ticketData, pid) => {
        handleNewTicket(docId, ticketData, pid);
      },
      onError: (err) => {
        writeLogFile(`Listener error for ${projectId}: ${err.message}`);
      },
    });
    listenerUnsubs.push(unsub);

    // Also watch for tickets entering the 'blocked' state so maintenance
    // runs immediately rather than waiting for the next scheduled interval.
    const blockedUnsub = startBlockedTicketListener(db, projectId, {
      onBlockedTicket: (docId, ticketData, pid) => {
        handleBlockedTicket(docId, ticketData, pid);
      },
      onError: (err) => {
        writeLogFile(`Blocked listener error for ${projectId}: ${err.message}`);
      },
    });
    listenerUnsubs.push(blockedUnsub);

    // Watch for open tickets being marked critical so they can bypass the
    // worker cap even if they were already sitting in the queue.
    const criticalUnsub = startCriticalTicketListener(db, projectId, {
      onCriticalTicket: (docId, ticketData, pid) => {
        handleCriticalUpgrade(docId, ticketData, pid);
      },
      onError: (err) => {
        writeLogFile(`Critical listener error for ${projectId}: ${err.message}`);
      },
    });
    listenerUnsubs.push(criticalUnsub);

    // Single collection-level listener for all paused (waiting_for_user) tickets.
    // Replaces the previous approach of creating one document listener per paused
    // ticket so that the number of open Firestore connections stays constant
    // regardless of how many tickets are paused.
    //
    // startPausedTicketsListener fires onTicketChanged when a ticket's status
    // changes *away* from waiting_for_user (Firestore 'removed' event), which
    // means the user has responded and we should resume the worker.
    const pausedUnsub = startPausedTicketsListener(db, projectId, {
      onTicketChanged: (docId) => {
        // A 'removed' event from the waiting_for_user query means this ticket
        // is no longer paused — resume the worker if we have one for it.
        if (pausedWorkers.has(docId)) {
          const paused = pausedWorkers.get(docId);
          writeLogFile(`${paused.ticketId} answered — resuming`);
          handleResume(docId);
        }
      },
      onError: (err) => {
        writeLogFile(`Paused-tickets listener error for ${projectId}: ${err.message}`);
      },
    });
    listenerUnsubs.push(pausedUnsub);

    writeLogFile(`Listening on ${projectId}`);
  }

  function subscribeToOrchestratorConfig() {
    const unsub = db.collection('orchestrator').doc('config').onSnapshot(
      (snap) => {
        if (!snap.exists) return;
        const data = snap.data();
        if (typeof data.maxWorkers === 'number' && data.maxWorkers >= 1 && data.maxWorkers <= MAX_WORKERS_LIMIT) {
          const prev = config.maxWorkers;
          config.maxWorkers = data.maxWorkers;
          if (prev !== config.maxWorkers) {
            writeLogFile(`Max workers updated via web UI: ${prev} → ${config.maxWorkers}`);
            scheduleRender();
            // Dequeue next if pool was increased
            if (config.maxWorkers > prev) dequeueNext();
          }
        } else if (typeof data.maxWorkers === 'number' && data.maxWorkers > MAX_WORKERS_LIMIT) {
          writeLogFile(`WARNING: Ignoring suspicious maxWorkers value from Firestore: ${data.maxWorkers} (max allowed: ${MAX_WORKERS_LIMIT})`);
        }
        // Check for sonnetPaused toggle from the web UI
        // When true, workers use haiku by default (non-sonnet mode).
        if (typeof data.sonnetPaused === 'boolean' && data.sonnetPaused !== state.nonSonnetMode) {
          state.nonSonnetMode = data.sonnetPaused;
          if (state.nonSonnetMode) {
            writeLogFile(`[non-sonnet] Sonnet paused — workers will use ${fallbackModel || 'haiku'} (upgrade: ${upgradeModel})`);
          } else {
            writeLogFile(`[non-sonnet] Sonnet resumed — workers will use ${model}`);
          }
          scheduleRender();
        }

        // Check for a kill signal from the web UI
        if (data.killSignal && data.killSignal !== state.lastSeenKillSignal) {
          state.lastSeenKillSignal = data.killSignal;
          writeLogFile('Kill signal received from web UI — shutting down');
          writeLogFile('Kill signal received from web UI');
          shutdown().then(() => process.exit(0)).catch(() => process.exit(1));
          return;
        }
        // Check for a manual maintenance trigger from the web UI
        if (data.manualTrigger && data.manualTrigger !== state.lastSeenManualTrigger) {
          state.lastSeenManualTrigger = data.manualTrigger;
          if (state.maintenanceRunning) {
            // Queue a follow-up run so "Run Now" is never silently dropped
            writeLogFile('Maintenance already running — queuing a follow-up run after current pass');
            state.pendingMaintenanceAfterCurrent = true;
          } else {
            writeLogFile('Manual maintenance triggered via web UI');
            if (state.maintenanceTimer) {
              clearTimeout(state.maintenanceTimer);
              state.maintenanceTimer = null;
            }
            runScheduledMaintenance().catch(err => {
              writeLogFile(`Manual maintenance error: ${err.stack || err.message}`);
            });
          }
          scheduleRender();
        }

        // Check for canary promotion requests from the web UI
        // Format: data.promoteCanary = { [projectId]: timestampString, ... }
        if (data.promoteCanary && typeof data.promoteCanary === 'object') {
          for (const [projectId, timestamp] of Object.entries(data.promoteCanary)) {
            if (!timestamp || timestamp === lastSeenPromoteCanary[projectId]) continue;
            lastSeenPromoteCanary[projectId] = timestamp;

            const projectConfig = projects[projectId];
            if (!projectConfig) {
              writeLogFile(`[promote] Promote requested for unknown project: ${projectId}`);
              continue;
            }

            writeLogFile(`[promote] Promotion request for ${projectId} from web UI`);
            // Run promotion asynchronously — don't block the snapshot handler
            (async () => {
              // Mark promotion as running in Firestore
              const promoteRef = db.collection('orchestrator').doc('promotions');
              try {
                await promoteRef.set({
                  [projectId]: { status: 'running', startedAt: new Date().toISOString(), error: null },
                }, { merge: true });

                await promoteCanary(projectId, projectConfig.repoPath, projectConfig, (msg) => writeLogFile(msg));

                await promoteRef.set({
                  [projectId]: { status: 'done', completedAt: new Date().toISOString(), error: null },
                }, { merge: true });
                writeLogFile(`[promote] Promotion of ${projectId} complete`);
              } catch (err) {
                writeLogFile(`[promote] Promotion failed for ${projectId}: ${err.message}`);
                try {
                  await promoteRef.set({
                    [projectId]: { status: 'error', error: err.message.slice(0, 500), failedAt: new Date().toISOString() },
                  }, { merge: true });
                } catch {
                  // best-effort
                }
              }
            })().catch(err => writeLogFile(`[promote] Unhandled promotion error: ${err.message}`));
          }
        }
      },
      (err) => {
        writeLogFile(`Config listener error: ${err.message}`);
      }
    );
    listenerUnsubs.push(unsub);
  }

  function subscribeToMaintenanceStatus() {
    const unsub = db.collection('orchestrator').doc('maintenance').onSnapshot(
      (snap) => {
        state.maintenanceStatus = snap.exists ? snap.data() : null;
        scheduleRender();
      },
      () => {
        // Ignore errors — maintenance status is optional
      }
    );
    listenerUnsubs.push(unsub);
  }

  function subscribeToAdvisorPersonas() {
    for (const personaId of ['engineer', 'design', 'product']) {
      const unsub = db.collection('advisor').doc(personaId).onSnapshot(
        (snap) => {
          advisorPersonaState[personaId] = snap.exists ? snap.data() : null;
          scheduleRender();
        },
        () => {
          // Ignore errors — advisor state is optional
        }
      );
      listenerUnsubs.push(unsub);
    }
  }

  function subscribeToProjectsCollection() {
    // Watch the top-level `projects` Firestore collection so that projects
    // created through the web UI (or CLI) are picked up automatically without
    // requiring an orchestrator restart.
    //
    // For each project document that is 'added' (either on initial snapshot or
    // later as a real-time change) we register listeners if we haven't already.
    // Projects that were in docket.config.json are already registered above, so
    // they are safely skipped (registeredProjectIds check).
    const unsub = db.collection('projects').onSnapshot(
      (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (change.type === 'added') {
            const projectId = change.doc.id;
            if (!registeredProjectIds.has(projectId)) {
              const data = change.doc.data();
              const dynamicConfig = {
                repoPath: data.repoPath || '',
                autoDeploy: data.autoDeploy ?? true,
                canaryDeployCommand: data.canaryDeployCommand || 'npm run deploy:canary',
                promoteCommand: data.promoteCommand || 'npm run promote:canary',
                ...(data.deployCommand && { deployCommand: data.deployCommand }),
                ...(data.webDir && { webDir: data.webDir }),
                ...(data.versionPaths && { versionPaths: data.versionPaths }),
                ...(data.versionFiles && { versionFiles: data.versionFiles }),
                ...(data.firestoreRulesCommand && { firestoreRulesCommand: data.firestoreRulesCommand }),
                ...(data.dependents && { dependents: data.dependents }),
              };
              // Auto-provision repoPath and bootstrap new projects.
              const setup = async () => {
                if (!dynamicConfig.repoPath) {
                  const ok = await ensureProjectRepo(projectId, dynamicConfig);
                  if (ok) {
                    writeLogFile(`[orchestrator] Auto-provisioned repoPath for discovered project: ${projectId}`);
                  } else {
                    writeLogFile(`[orchestrator] Failed to auto-provision repoPath for ${projectId}`);
                    return;
                  }
                }
                await bootstrapNewProject(projectId, data);
              };
              setup().catch(err => {
                writeLogFile(`[orchestrator] Error during project setup for ${projectId}: ${err.message}`);
              });
              writeLogFile(`[orchestrator] Discovered new project in Firestore: ${projectId} — registering listeners`);
              registerProjectListeners(projectId, dynamicConfig);
            }
          } else if (change.type === 'modified') {
            // A project document was updated in Firestore (e.g. repoPath configured
            // via the admin panel).  Sync the in-memory projects config so workers
            // and maintenance can use the updated values.
            const projectId = change.doc.id;
            const data = change.doc.data();
            const hadRepoPath = !!(projects[projectId] && projects[projectId].repoPath);
            const nowHasRepoPath = !!(data.repoPath);

            if (projects[projectId]) {
              // Update all fields that the orchestrator uses from the project config.
              // Preserve deploy defaults for dynamically discovered projects —
              // only overwrite autoDeploy if Firestore explicitly sets it.
              const merged = { ...data };
              if (merged.autoDeploy === undefined) {
                merged.autoDeploy = projects[projectId].autoDeploy;
              }
              if (!merged.canaryDeployCommand && projects[projectId].canaryDeployCommand) {
                merged.canaryDeployCommand = projects[projectId].canaryDeployCommand;
              }
              if (!merged.promoteCommand && projects[projectId].promoteCommand) {
                merged.promoteCommand = projects[projectId].promoteCommand;
              }
              Object.assign(projects[projectId], merged);
            } else {
              projects[projectId] = {
                autoDeploy: true,
                canaryDeployCommand: 'npm run deploy:canary',
                promoteCommand: 'npm run promote:canary',
                ...data,
              };
            }

            writeLogFile(`[orchestrator] Project "${projectId}" config updated in Firestore — synced in-memory config`);

            // If repoPath was just configured for the first time, trigger a
            // maintenance pass so any tickets blocked due to missing repoPath
            // are retried immediately.
            if (!hadRepoPath && nowHasRepoPath) {
              writeLogFile(`[orchestrator] Project "${projectId}" now has repoPath — scheduling maintenance to retry blocked tickets`);
              if (!state.maintenanceRunning) {
                if (state.blockedMaintenanceTimer) {
                  clearTimeout(state.blockedMaintenanceTimer);
                  state.blockedMaintenanceTimer = null;
                }
                state.blockedMaintenanceTimer = setTimeout(() => {
                  state.blockedMaintenanceTimer = null;
                  runScheduledMaintenance().catch(err => {
                    writeLogFile(`[orchestrator] Maintenance error after repoPath set: ${err.stack || err.message}`);
                  });
                }, 2000);
              } else {
                state.pendingMaintenanceAfterCurrent = true;
              }
            }
          }
        }
      },
      (err) => {
        writeLogFile(`[orchestrator] Projects collection listener error: ${err.message}`);
      }
    );
    listenerUnsubs.push(unsub);
  }

  return {
    registerProjectListeners,
    subscribeToOrchestratorConfig,
    subscribeToMaintenanceStatus,
    subscribeToAdvisorPersonas,
    subscribeToProjectsCollection,
  };
}
