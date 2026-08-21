import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesDir = path.join(root, "src-tauri", "resources");
const nodeSource = process.env.TMALL_NODE_PATH || process.execPath;
const defaultReleaseConfig = process.env.APPDATA
  ? path.join(process.env.APPDATA, "com.local.tmall-sku-worker", "worker", "runtime-config.json")
  : "";

async function readReleaseRuntimeConfig() {
  const configuredPath = process.env.TMALL_RELEASE_RUNTIME_CONFIG || defaultReleaseConfig;
  if (!configuredPath) throw new Error("发布构建缺少 TMALL_RELEASE_RUNTIME_CONFIG");
  const source = path.isAbsolute(configuredPath) ? configuredPath : path.resolve(root, configuredPath);
  let values;
  try {
    values = JSON.parse(await fs.readFile(source, "utf8"));
  } catch (cause) {
    throw new Error(`发布运行时配置无法读取: ${cause.message}`);
  }
  const token = String(values?.INVENTORY_API_TOKEN || "").trim();
  if (!token) throw new Error("发布运行时配置缺少 INVENTORY_API_TOKEN");
  return { INVENTORY_API_TOKEN: token };
}

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

async function packageDirectory(name, fromDirectory = root) {
  let current = fromDirectory;
  while (true) {
    const candidate = path.join(current, "node_modules", name);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`无法解析运行时依赖: ${name}`);
}

const copiedPackages = new Set();
async function copyPackage(name, fromDirectory = root, { force = false } = {}) {
  const source = await packageDirectory(name, fromDirectory);
  const packageJsonPath = path.join(source, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  } catch (cause) {
    throw new Error(`运行时依赖不存在或 package.json 无法读取: ${name}: ${cause.message}`);
  }
  const realSource = await fs.realpath(source);
  if (copiedPackages.has(realSource) && !force) return;
  copiedPackages.add(realSource);
  await copyRequired(source, path.join(resourcesDir, "node_modules", name));
  const optionalDependencies = new Set(Object.keys(manifest.optionalDependencies || {}));
  const dependencies = { ...(manifest.dependencies || {}), ...(manifest.optionalDependencies || {}) };
  for (const dependency of Object.keys(dependencies)) {
    try {
      await copyPackage(dependency, source);
    } catch (error) {
      if (!optionalDependencies.has(dependency)) throw error;
    }
  }
}

const releaseRuntimeConfig = await readReleaseRuntimeConfig();
await fs.rm(resourcesDir, { recursive: true, force: true });
await fs.mkdir(resourcesDir, { recursive: true });

await fs.writeFile(
  path.join(resourcesDir, "default-runtime-config.json"),
  `${JSON.stringify(releaseRuntimeConfig, null, 2)}\n`,
  "utf8",
);
await copyRequired(nodeSource, path.join(resourcesDir, "node.exe"));
for (const packageName of ["playwright", "playwright-core", "mysql2", "exceljs"]) await copyPackage(packageName);
// ExcelJS requires readable-stream 3.x. A prior flat copy could let a 2.x transitive dependency win at the root.
const exceljsDirectory = await packageDirectory("exceljs");
await copyPackage("readable-stream", exceljsDirectory, { force: true });

const nodeBytes = (await fs.stat(path.join(resourcesDir, "node.exe"))).size;
console.log(`Prepared bundled Node runtime (${Math.round(nodeBytes / 1024 / 1024)} MB), fixed workflow credential, and ${copiedPackages.size} runtime packages.`);
