import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const registryPath = fileURLToPath(new URL('../registry.json', import.meta.url));
const raw = readFileSync(registryPath, 'utf8');
const registry = JSON.parse(raw);
const plugin = registry.plugins?.find((item) => item.id === 'cpa-plugin-cx-panel');
if (!plugin) throw new Error('registry entry cpa-plugin-cx-panel not found');

const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(plugin.version));
if (!match) throw new Error(`invalid registry version: ${plugin.version}`);

plugin.version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2).replaceAll('\n', eol)}${eol}`);
console.log(`Updated registry version to ${plugin.version}`);
