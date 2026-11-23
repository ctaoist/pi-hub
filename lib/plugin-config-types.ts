/** JSON configuration only; examples are values, not JSON Schema. */
export type PluginConfigJson = null | boolean | number | string | PluginConfigJson[] | { [key: string]: PluginConfigJson };
export type PluginConfigKind = "string" | "number" | "boolean" | "json";

export interface PluginConfigField {
  path: string[];
  kind: PluginConfigKind;
  present: boolean;
  secret: boolean;
  /** Sensitive values (including examples) are never sent to the browser. */
  value?: PluginConfigJson;
}

export interface PluginConfigDocument {
  id: string;
  path: string;
  packageLocal: boolean;
  exists: boolean;
  examplePath?: string;
  revision?: string;
  fields?: PluginConfigField[];
  error?: string;
}

export interface PluginConfigListing { files: PluginConfigDocument[] }
export interface PluginConfigChange {
  path: string[];
  action: "set" | "remove";
  value?: PluginConfigJson;
}

export const PLUGIN_CONFIG_MAX_BYTES = 128 * 1024;
export const PLUGIN_CONFIG_MAX_FIELDS = 300;

export function pluginConfigFieldKey(path: string[]): string { return JSON.stringify(path); }

export function pluginConfigKind(value: PluginConfigJson): PluginConfigKind {
  return typeof value === "string" ? "string" : typeof value === "number" ? "number"
    : typeof value === "boolean" ? "boolean" : "json";
}

/** No parser error text: engines can include part of a credential in it. */
export function parsePluginConfigValue(kind: PluginConfigKind, text: string): PluginConfigJson {
  if (kind === "string") return text;
  const value = JSON.parse(text) as PluginConfigJson;
  if (kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error("invalid");
  if (kind === "boolean" && typeof value !== "boolean") throw new Error("invalid");
  return value;
}
