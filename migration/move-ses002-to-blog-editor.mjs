#!/usr/bin/env node
// Migration: Create blog-editor project in Firestore and move SES-002 into it.

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const configPath = resolve(dirname(new URL(import.meta.url).pathname), '..', 'docket.config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const configDir = dirname(configPath);

const keyPath = resolve(configDir, config.firebaseKeyPath);
const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf-8'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function main() {
  // 1. Create the blog-editor project document if it doesn't exist
  const projRef = db.collection('projects').doc('blog-editor');
  const projDoc = await projRef.get();

  if (!projDoc.exists) {
    await projRef.set({
      name: 'Blog Editor',
      prefix: 'BE',
      nextTicketNumber: 1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('Created blog-editor project (prefix: BE)');
  } else {
    console.log('blog-editor project already exists');
  }

  // 2. Find SES-002 in the sessions project
  const sessionsTickets = db.collection('projects').doc('sessions').collection('tickets');
  const snapshot = await sessionsTickets.where('ticketId', '==', 'SES-002').get();

  if (snapshot.empty) {
    console.log('SES-002 not found in sessions — nothing to move');
    process.exit(0);
  }

  for (const doc of snapshot.docs) {
    const data = doc.data();
    console.log(`Found SES-002: "${data.title}" (status: ${data.status}, docId: ${doc.id})`);

    // 3. Create the ticket in blog-editor project with new ticket ID
    const beProj = await projRef.get();
    const beData = beProj.data();
    const nextNum = beData.nextTicketNumber || 1;
    const newTicketId = `BE-${String(nextNum).padStart(3, '0')}`;

    const newData = {
      ...data,
      ticketId: newTicketId,
      ticketNumber: nextNum,
      projectId: 'blog-editor',
      statusHistory: [
        ...(data.statusHistory || []),
        { from: data.status, to: data.status, at: new Date().toISOString(), note: `Moved from sessions (was ${data.ticketId})` },
      ],
    };

    const beTickets = db.collection('projects').doc('blog-editor').collection('tickets');
    await beTickets.doc(doc.id).set(newData);
    await projRef.update({ nextTicketNumber: nextNum + 1 });
    console.log(`Created ${newTicketId} in blog-editor`);

    // 4. Delete from sessions
    await sessionsTickets.doc(doc.id).delete();
    console.log(`Deleted SES-002 from sessions`);

    console.log(`Done: SES-002 → ${newTicketId}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
