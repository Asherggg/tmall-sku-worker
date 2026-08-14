import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.join(root, "src-tauri", "resources");
const nodeSource = process.env.TMALL_NODE_PATH || process.execPath;

async function copyRequired(source, destination) {
  try {
    await fs.access(source);
  } catch {
    throw new Error(`运行时依赖不存在: ${source}`);
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

await fs.rm(resourcesDir, { recursive: true, force: true });
await fs.mkdir(resourcesDir, { recursive: true });

await copyRequired(nodeSource, path.join(resourcesDir, "node.exe"));
await copyRequired(path.join(root, "node_modules", "playwright"), path.join(resourcesDir, "node_modules", "playwright"));
await copyRequired(path.join(root, "node_modules", "playwright-core"), path.join(resourcesDir, "node_modules", "playwright-core"));

const nodeBytes = (await fs.stat(path.join(resourcesDir, "node.exe"))).size;
console.log(`Prepared bundled Node runtime (${Math.round(nodeBytes / 1024 / 1024)} MB) and Playwright packages.`);
