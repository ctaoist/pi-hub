import { NextResponse } from "next/server";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { discoverPluginConfigs, discoverStandaloneConfig, listPluginConfigs, PluginConfigError, savePluginConfig } from "@/lib/plugin-config";
import { readPluginConfigRequest } from "@/lib/plugin-config-request";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

async function targetsFor(input: Record<string, unknown>) {
  const { cwd, source, scope } = input;
  const kind = input.kind ?? "package";
  if (kind !== "package" && kind !== "extension") throw new PluginConfigError("invalid");
  if (typeof cwd !== "string" || !isAbsolute(cwd) || typeof source !== "string" || !source || source.length > 4096
    || (scope !== "global" && scope !== "project")) throw new PluginConfigError("invalid");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new PluginConfigError("denied", 403);
  const agentDir = getAgentDir();
  const trusted = getProjectTrustStatus(cwd, agentDir).trusted;
  if (scope === "project" && !trusted) throw new PluginConfigError("denied", 403);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  if (settingsManager.drainErrors().length) throw new PluginConfigError("unavailable");
  if (kind === "extension") {
    // Keep Pi's local discovery, scope and override semantics, but give the SDK
    // an in-memory extensions-only settings view. No package source is resolved,
    // so listing cannot install/update packages or execute extension code.
    const localSettings = SettingsManager.fromStorage({
      withLock(settingsScope, read) {
        const settings = settingsScope === "global" ? settingsManager.getGlobalSettings() : settingsManager.getProjectSettings();
        read(JSON.stringify({ extensions: settings.extensions ?? [] }));
      },
    }, { projectTrusted: trusted });
    const paths = await new DefaultPackageManager({ cwd, agentDir, settingsManager: localSettings, builtinExtensions: [] }).resolve();
    const extension = paths.extensions.find((item) => item.path === source && item.metadata.origin === "top-level"
      && item.metadata.scope === (scope === "global" ? "user" : "project"));
    if (!extension) throw new PluginConfigError("missing", 404);
    return discoverStandaloneConfig(extension.path, [agentDir, cwd, join(cwd, ".pi"), join(agentDir, "extensions"), join(cwd, ".pi", "extensions")]);
  }
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  // Package identities use only installed paths; package resolution/install never runs.
  const pkg = manager.listConfiguredPackages().find((item) => item.source === source && item.scope === (scope === "global" ? "user" : "project"));
  if (settingsManager.drainErrors().length) throw new PluginConfigError("unavailable");
  if (!pkg?.installedPath) throw new PluginConfigError("missing", 404);
  return discoverPluginConfigs({ source, installedPath: pkg.installedPath, cwd, projectTrusted: trusted, home: homedir(), env: process.env });
}
function failure(error: unknown) {
  const known = error instanceof PluginConfigError;
  return NextResponse.json({ error: known ? error.code : "unavailable" }, { status: known ? error.status : 500, headers });
}
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return failure(new PluginConfigError("denied", 403));
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return NextResponse.json(listPluginConfigs(await targetsFor(params)), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return failure(new PluginConfigError("denied", 403));
  if (!hasJsonContentType(request)) return failure(new PluginConfigError("invalid", 415));
  try {
    const body = await readPluginConfigRequest(request);
    const target = (await targetsFor(body)).find((item) => item.id === body.id);
    if (!target) throw new PluginConfigError("missing", 404);
    const file = await savePluginConfig(target, body.revision, body.changes, body.confirmCreate, async () => {
      const current = (await targetsFor(body)).find((item) => item.id === body.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(target)) throw new PluginConfigError("conflict", 409);
    });
    return NextResponse.json({ file }, { headers });
  } catch (error) { return failure(error); }
}
