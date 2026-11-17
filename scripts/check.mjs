// Checks the key in .env: lists projects and one project's flags. Prints no secrets.
//   node scripts/check.mjs [projectId]
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PostHog } from '../lib/posthog.js';
import { variantsOf, groupsOf } from '../lib/logic.js';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const env = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const apiKey = env.POSTHOG_PERSONAL_API_KEY?.trim();
if (!apiKey) {
  console.error('POSTHOG_PERSONAL_API_KEY is not set in .env (see .env.example).');
  process.exit(1);
}

const client = new PostHog({ apiKey, host: env.POSTHOG_HOST?.trim() || 'https://eu.posthog.com' });
const projects = await client.listProjects();
console.log(`Projects visible to the key: ${projects.length}`);
for (const p of projects) console.log(`  ${p.id}  ${p.name}  (${p.orgName})`);

const projectId = Number(process.argv[2] ?? projects[0]?.id);
if (!projectId) process.exit(0);
const flags = await client.listFlags(projectId);
console.log(`\nFlags in ${projectId}: ${flags.length}`);
for (const f of flags) {
  const variants = variantsOf(f.filters).map((v) => `${v.key} ${v.rollout_percentage}%`).join(', ');
  const rollout = groupsOf(f.filters).map((g) => `${g.rollout_percentage ?? 100}%`).join('/');
  console.log(`  ${f.key}  ${f.active ? 'on' : 'off'}  rollout ${rollout}${variants ? `  [${variants}]` : ''}`);
}
