// tickets projects <subcommand> — Manage projects
// Subcommands: list, add
// add flags: --id, --prefix, --name, --repo-path, --scan-paths, --admin-email

import { createProjectService } from '@docket/core';

export async function run({ db, config, flags, positional }) {
  const sub = positional[1]; // "list" or "add"

  if (!sub || (sub !== 'list' && sub !== 'add')) {
    console.error('Usage: tickets projects <list|add> [options]');
    console.error('');
    console.error('  tickets projects list');
    console.error('  tickets projects add --id <id> --prefix <PREFIX> --name <name> [--repo-path <path>] [--scan-paths <paths>] [--admin-email <email>]');
    process.exit(1);
  }

  const projectService = createProjectService(db);

  if (sub === 'list') {
    await listProjects(projectService, flags);
  } else if (sub === 'add') {
    await addProject(projectService, flags, config);
  }
}

async function listProjects(projectService, flags) {
  const projects = await projectService.list();

  if (flags.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  const cols = [
    pad('ID', 20),
    pad('Prefix', 8),
    pad('Name', 30),
    'Repo Path',
  ];
  console.log(cols.join('  '));
  console.log('-'.repeat(80));

  for (const p of projects) {
    const row = [
      pad(p.id, 20),
      pad(p.prefix, 8),
      pad(p.name, 30),
      p.repoPath || '-',
    ];
    console.log(row.join('  '));
  }

  console.log(`\n${projects.length} project(s)`);
}

async function addProject(projectService, flags, config) {
  const id = flags.id;
  const prefix = flags.prefix;
  const name = flags.name;

  if (!id || !prefix || !name) {
    console.error('Error: --id, --prefix, and --name are required.');
    console.error('Example: tickets projects add --id knowledgebase --prefix KB --name "Knowledge Base"');
    process.exit(1);
  }

  // Use --admin-email flag, or fall back to config default (DOCKET_ADMIN_EMAIL / defaults.adminEmail)
  const adminEmail = flags['admin-email'] || config?.adminEmail || '';
  const adminEmails = adminEmail ? [adminEmail] : [];

  // --scan-paths accepts a comma-separated list, e.g. "src,lib,packages/*/src"
  const scanPaths = flags['scan-paths']
    ? flags['scan-paths'].split(',').map(p => p.trim()).filter(Boolean)
    : undefined;

  const project = await projectService.register({
    id,
    prefix,
    name,
    repoPath: flags['repo-path'] || '',
    scanPaths,
    adminEmails,
  });

  if (flags.json) {
    console.log(JSON.stringify(project, null, 2));
  } else {
    console.log(`Registered project "${project.name}" (${project.prefix}) with id "${project.id}".`);
  }
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
