// docket scaffold — Create a new project from scratch using a single prompt
//
// Usage:
//   docket scaffold "A markdown blog editor with live preview"
//   docket scaffold "Todo app" --id todo-app --prefix TA --name "Todo App"
//   docket scaffold "E-commerce store" --repo-path /path/to/repo --admin-email me@example.com
//
// Uses Claude AI to derive project metadata (id, prefix, name) from the prompt,
// then registers the project in Firestore and updates docket.config.json.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createProjectService } from '@docket/core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export async function run({ db, admin, config, flags, positional }) {
  // ── Parse args ──────────────────────────────────────────────────────
  const prompt = positional.slice(1).join(' ').trim();

  if (!prompt) {
    console.error('Usage: docket scaffold "<description of your project>"');
    console.error('');
    console.error('Examples:');
    console.error('  docket scaffold "A markdown blog editor with live preview"');
    console.error('  docket scaffold "E-commerce store" --id shop --prefix SH --name "My Shop"');
    console.error('');
    console.error('Flags:');
    console.error('  --id <id>              Override the project ID (slug)');
    console.error('  --prefix <PREFIX>      Override the ticket prefix (2-4 uppercase letters)');
    console.error('  --name <name>          Override the project name');
    console.error('  --repo-path <path>     Absolute path to the project repo');
    console.error('  --scan-paths <paths>   Comma-separated subdirs to scan (e.g. "src,lib")');
    console.error('  --admin-email <email>  Admin email for the web UI');
    console.error('  --dry-run              Show what would be created without creating it');
    process.exit(1);
  }

  const dryRun = flags['dry-run'] || false;

  // ── Derive metadata via Claude (unless all overrides provided) ───────
  let projectId = flags.id || null;
  let prefix = flags.prefix || null;
  let name = flags.name || null;

  const needsAI = !projectId || !prefix || !name;

  if (needsAI) {
    console.log('Analyzing project description with Claude...');

    let aiResult;
    try {
      aiResult = await deriveMetadataWithClaude(prompt);
    } catch (err) {
      console.error('Error: Failed to get metadata from Claude:', err.message);
      console.error('You can bypass AI by providing --id, --prefix, and --name manually.');
      process.exit(1);
    }

    // Apply AI results where flags didn't override
    if (!projectId) projectId = aiResult.id;
    if (!prefix) prefix = aiResult.prefix;
    if (!name) name = aiResult.name;
  }

  // ── Validate derived/provided metadata ──────────────────────────────
  if (!projectId || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(projectId)) {
    console.error(`Error: Invalid project ID "${projectId}". Must be lowercase letters, numbers, and hyphens.`);
    process.exit(1);
  }

  if (!prefix || !/^[A-Z]{2,4}$/.test(prefix)) {
    console.error(`Error: Invalid prefix "${prefix}". Must be 2-4 uppercase letters.`);
    process.exit(1);
  }

  if (!name) {
    console.error('Error: Project name is required.');
    process.exit(1);
  }

  const repoPath = flags['repo-path'] || '';
  // Use --admin-email flag, or fall back to config default (DOCKET_ADMIN_EMAIL / defaults.adminEmail)
  const adminEmail = flags['admin-email'] || config?.adminEmail || '';
  const adminEmails = adminEmail ? [adminEmail] : [];
  // --scan-paths accepts a comma-separated list, e.g. "src,lib,packages/*/src"
  const scanPaths = flags['scan-paths']
    ? flags['scan-paths'].split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  // ── Show plan ────────────────────────────────────────────────────────
  console.log('');
  console.log('Project to create:');
  console.log(`  ID:        ${projectId}`);
  console.log(`  Prefix:    ${prefix}`);
  console.log(`  Name:      ${name}`);
  if (repoPath) console.log(`  Repo:      ${repoPath}`);
  if (scanPaths) console.log(`  Scan:      ${scanPaths.join(', ')}`);
  if (adminEmail) console.log(`  Admin:     ${adminEmail}`);
  console.log('');

  if (dryRun) {
    console.log('(dry-run mode — nothing was created)');
    return;
  }

  // ── 1. Register project in Firestore ─────────────────────────────────
  const projectService = createProjectService(db);
  const existing = await projectService.get(projectId);

  if (existing) {
    console.log(`Project "${projectId}" already registered in Firestore — skipping.`);
  } else {
    await projectService.register({
      id: projectId,
      prefix,
      name,
      repoPath,
      scanPaths,
      adminEmails,
    });
    console.log(`✓ Registered project "${name}" (${prefix}) in Firestore.`);
  }

  // ── 2. Update docket.config.json ─────────────────────────────────────
  if (config._configPath) {
    try {
      const configPath = config._configPath;
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));

      if (!raw.projects) raw.projects = {};

      if (raw.projects[projectId]) {
        console.log(`Project "${projectId}" already in docket.config.json — skipping config update.`);
      } else {
        const projectConfig = {};
        if (repoPath) projectConfig.repoPath = repoPath;
        if (scanPaths) projectConfig.scanPaths = scanPaths;

        raw.projects[projectId] = projectConfig;
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
        console.log(`✓ Added "${projectId}" to docket.config.json.`);
      }
    } catch (err) {
      console.warn(`Warning: Could not update docket.config.json: ${err.message}`);
    }
  } else {
    console.log('Note: No docket.config.json found — skipping config update.');
    console.log(`To enable orchestrator support, add "${projectId}" to your docket.config.json manually.`);
  }

  // ── Done ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(`Done! Project "${name}" is ready.`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Add your first ticket:`);
  console.log(`     docket add --project ${projectId} --type feature --title "Hello world"`);
  if (!repoPath) {
    console.log(`  2. Set the repo path in docket.config.json to enable the orchestrator:`);
    console.log(`     "projects": { "${projectId}": { "repoPath": "/path/to/your/repo" } }`);
  }
  console.log(`  3. Restart the orchestrator to pick up the new project.`);
}

// ── Claude AI metadata derivation ────────────────────────────────────────

async function deriveMetadataWithClaude(prompt) {
  const systemPrompt = `You are a project naming assistant. Given a description of a software project, derive:
1. A project ID (lowercase slug, letters/numbers/hyphens, 2-30 chars, no leading/trailing hyphens)
2. A ticket prefix (2-4 uppercase letters, abbreviated from the project name)
3. A human-readable project name (title case, concise)

Respond with ONLY a JSON object, no markdown, no explanation:
{"id": "...", "prefix": "...", "name": "..."}

Rules:
- id: kebab-case slug, e.g. "blog-editor", "todo-app", "ecommerce-store"
- prefix: 2-4 uppercase letters, e.g. "BE", "TA", "EC"
- name: title case, e.g. "Blog Editor", "Todo App", "E-commerce Store"`;

  let responseText = '';

  for await (const message of query({
    prompt: `Project description: ${prompt}`,
    options: {
      system: systemPrompt,
      model: 'claude-haiku-4-5',
      maxTurns: 1,
    },
  })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseText += block.text;
        }
      }
    }
  }

  responseText = responseText.trim();

  // Strip markdown code fences if present
  responseText = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    throw new Error(`Could not parse Claude response as JSON: "${responseText}"`);
  }

  if (!parsed.id || !parsed.prefix || !parsed.name) {
    throw new Error(`Claude response missing required fields: ${JSON.stringify(parsed)}`);
  }

  return {
    id: String(parsed.id).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, ''),
    prefix: String(parsed.prefix).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4),
    name: String(parsed.name),
  };
}
