#!/usr/bin/env node

import { readFileSync } from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    keyPath: null,
    projectId: "knowledgebase",
    prefix: "KB",
    name: "Knowledgebase",
    adminEmails: [],
    repoPath: null,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--key-path" && argv[i + 1]) {
      args.keyPath = argv[++i];
    } else if (arg === "--project-id" && argv[i + 1]) {
      args.projectId = argv[++i];
    } else if (arg === "--prefix" && argv[i + 1]) {
      args.prefix = argv[++i];
    } else if (arg === "--name" && argv[i + 1]) {
      args.name = argv[++i];
    } else if (arg === "--admin-email" && argv[i + 1]) {
      args.adminEmails.push(argv[++i]);
    } else if (arg === "--repo-path" && argv[i + 1]) {
      args.repoPath = argv[++i];
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!args.keyPath) {
    console.error("Error: --key-path is required");
    printUsage();
    process.exit(1);
  }

  return args;
}

function printUsage() {
  console.error(`
Usage: migrate.js --key-path <path> [options]

Required:
  --key-path <path>       Path to Firebase service account key JSON

Options:
  --project-id <id>       Project ID in new schema (default: "knowledgebase")
  --prefix <prefix>       Ticket prefix (default: "KB")
  --name <name>           Project display name (default: "Knowledgebase")
  --admin-email <email>   Admin email (can be specified multiple times)
  --repo-path <path>      GitHub repo path (e.g. "org/repo")
  --dry-run               Report what would happen without writing
`);
}

// ---------------------------------------------------------------------------
// Main migration logic
// ---------------------------------------------------------------------------

async function migrate(args) {
  const {
    keyPath,
    projectId,
    prefix,
    name,
    adminEmails,
    repoPath,
    dryRun,
  } = args;

  // ---- Initialize Firebase Admin ----
  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf-8"));

  initializeApp({
    credential: cert(serviceAccount),
  });

  const db = getFirestore();

  console.log(`\nMigration settings:`);
  console.log(`  Source collection : tickets/`);
  console.log(`  Target project    : projects/${projectId}`);
  console.log(`  Prefix            : ${prefix}`);
  console.log(`  Name              : ${name}`);
  console.log(`  Admin emails      : ${adminEmails.length > 0 ? adminEmails.join(", ") : "(none)"}`);
  console.log(`  Repo path         : ${repoPath ?? "(none)"}`);
  console.log(`  Dry run           : ${dryRun}`);
  console.log();

  // ---- Read all existing tickets ----
  console.log("Reading tickets from flat tickets/ collection...");
  const ticketsSnapshot = await db.collection("tickets").get();

  if (ticketsSnapshot.empty) {
    console.log("No tickets found. Nothing to migrate.");
    return;
  }

  const tickets = [];
  let maxTicketNumber = 0;

  ticketsSnapshot.forEach((doc) => {
    const data = doc.data();
    tickets.push({ id: doc.id, data });

    const num = typeof data.ticketNumber === "number" ? data.ticketNumber : 0;
    if (num > maxTicketNumber) {
      maxTicketNumber = num;
    }
  });

  const nextTicketNumber = maxTicketNumber + 1;

  console.log(`Found ${tickets.length} ticket(s).`);
  console.log(`Max ticketNumber: ${maxTicketNumber}`);
  console.log(`nextTicketNumber will be set to: ${nextTicketNumber}`);
  console.log();

  // ---- Build the project document ----
  const now = FieldValue.serverTimestamp();

  const projectDoc = {
    prefix,
    name,
    adminEmails,
    nextTicketNumber,
    createdAt: now,
    updatedAt: now,
  };

  if (repoPath) {
    projectDoc.repoPath = repoPath;
  }

  // ---- Dry-run reporting ----
  if (dryRun) {
    console.log("=== DRY RUN — no writes will be performed ===\n");

    console.log(`Would create project document at projects/${projectId}:`);
    console.log(
      JSON.stringify(
        { ...projectDoc, createdAt: "<serverTimestamp>", updatedAt: "<serverTimestamp>" },
        null,
        2,
      ),
    );
    console.log();

    console.log(
      `Would copy ${tickets.length} ticket(s) to projects/${projectId}/tickets/:`,
    );
    for (const ticket of tickets) {
      console.log(`  - ${ticket.id} (ticketId: ${ticket.data.ticketId ?? "N/A"}, title: ${ticket.data.title ?? "N/A"})`);
    }

    console.log("\n=== DRY RUN complete ===");
    return;
  }

  // ---- Write project document ----
  console.log(`Creating project document at projects/${projectId}...`);
  await db.collection("projects").doc(projectId).set(projectDoc);
  console.log("Project document created.");

  // ---- Copy tickets using batched writes ----
  // Firestore batches support up to 500 operations each.
  const BATCH_LIMIT = 499; // leave room for safety
  let batchCount = 0;
  let batch = db.batch();
  let opsInBatch = 0;

  for (const ticket of tickets) {
    const destRef = db
      .collection("projects")
      .doc(projectId)
      .collection("tickets")
      .doc(ticket.id);

    const ticketData = {
      ...ticket.data,
      projectId,
    };

    batch.set(destRef, ticketData);
    opsInBatch++;

    if (opsInBatch >= BATCH_LIMIT) {
      await batch.commit();
      batchCount++;
      console.log(`  Committed batch ${batchCount} (${opsInBatch} tickets)`);
      batch = db.batch();
      opsInBatch = 0;
    }
  }

  // Commit any remaining operations
  if (opsInBatch > 0) {
    await batch.commit();
    batchCount++;
    console.log(`  Committed batch ${batchCount} (${opsInBatch} tickets)`);
  }

  // ---- Summary ----
  console.log("\n=== Migration complete ===");
  console.log(`  Tickets migrated   : ${tickets.length}`);
  console.log(`  Max ticket number  : ${maxTicketNumber}`);
  console.log(`  nextTicketNumber   : ${nextTicketNumber}`);
  console.log(`  Project doc created: projects/${projectId}`);
  console.log(`  Batches committed  : ${batchCount}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);

migrate(args).catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
