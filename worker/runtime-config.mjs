import fs from "node:fs";
import path from "node:path";

function configPath() {
  return process.env.TMALL_RUNTIME_CONFIG
    || (process.env.TMALL_DATA_DIR ? path.join(process.env.TMALL_DATA_DIR, "runtime-config.json") : "");
}

export function readRuntimeConfig() {
  const file = configPath();
  if (!file) return { values: {}, error: null, path: null };
  try {
    const values = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("运行时配置必须是 JSON 对象");
    }
    return { values, error: null, path: file };
  } catch (cause) {
    if (cause?.code === "ENOENT") return { values: {}, error: null, path: file };
    return {
      values: {},
      path: file,
      error: Object.assign(new Error("运行时配置文件无效"), { code: "runtime_config_invalid", cause }),
    };
  }
}

export function runtimeValue(name) {
  if (process.env[name] !== undefined) return process.env[name];
  return readRuntimeConfig().values[name];
}

export function runtimeConfigError() {
  return readRuntimeConfig().error;
}

export function runtimeConfigPath() {
  return configPath() || null;
}
