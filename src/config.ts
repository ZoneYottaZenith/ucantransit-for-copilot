import * as vscode from "vscode";
import type { ModelEntry, ProtocolModeName, SiteEntry } from "./types";
import { displayNameOf } from "./displayName";
import { guessProtocol } from "./protocols";

/**
 * 配置读写。
 *
 * 多站点结构：sites[] + modelsBySite + 每个站点独立的 SecretStorage 键。
 * 老版本只有单个 baseUrl/models/apiKey，读取时自动迁移成一个名为“默认站点”的站点，
 * 旧配置不丢、也不影响使用。
 */

const SECTION = "ucantransit";
const SECRET_PREFIX = "ucantransit.apiKey";
const LEGACY_SECRET = "ucantransit.apiKey";
const LEGACY_SITE_ID = "default";

function config() {
	return vscode.workspace.getConfiguration(SECTION);
}

export function isEnabled(): boolean {
	return config().get<boolean>("enabled", true);
}

export async function setEnabled(enabled: boolean): Promise<void> {
	await config().update("enabled", enabled, vscode.ConfigurationTarget.Global);
}

const MODEL_MODES: ProtocolModeName[] = ["openai", "openai-responses", "anthropic", "gemini"];

/** 读模型协议：认不出来的（包括已下线的 ollama）按模型名重新推。 */
function normalizeModelMode(value: unknown, modelId: string): ProtocolModeName {
	return MODEL_MODES.includes(value as ProtocolModeName) ? (value as ProtocolModeName) : guessProtocol(modelId);
}

/** 读取站点列表，必要时把旧配置迁移进来。 */
export function getSites(): SiteEntry[] {
	const raw = config().get<unknown>("sites", []);
	const sites: SiteEntry[] = [];
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const record = item as Record<string, unknown>;
			const id = typeof record.id === "string" ? record.id : "";
			const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl : "";
			if (!id || !baseUrl) {
				continue;
			}
			sites.push({
				id,
				name: typeof record.name === "string" && record.name ? record.name : id,
				baseUrl: baseUrl.trim(),
				enabled: record.enabled !== false,
			});
		}
	}

	if (sites.length > 0) {
		return sites;
	}

	// 迁移旧配置
	const legacyUrl = config().get<string>("baseUrl", "").trim();
	if (!legacyUrl) {
		return [];
	}
	return [
		{
			id: LEGACY_SITE_ID,
			name: "默认站点",
			baseUrl: legacyUrl,
		},
	];
}

export function getActiveSiteId(): string {
	const stored = config().get<string>("activeSiteId", "");
	const sites = getSites();
	if (stored && sites.some((site) => site.id === stored)) {
		return stored;
	}
	return sites[0]?.id ?? "";
}

export function getActiveSite(): SiteEntry | undefined {
	const siteId = getActiveSiteId();
	return getSites().find((site) => site.id === siteId);
}

export async function setActiveSiteId(siteId: string): Promise<void> {
	await config().update("activeSiteId", siteId, vscode.ConfigurationTarget.Global);
}

/** 只改一个站点的启停，不动当前选中的站点。 */
export async function setSiteEnabled(siteId: string, enabled: boolean): Promise<void> {
	const sites = getSites().map((site) => (site.id === siteId ? { ...site, enabled } : site));
	await config().update("sites", sites, vscode.ConfigurationTarget.Global);
}

export async function saveSite(site: SiteEntry): Promise<void> {
	// 已存在的站点原位替换，不要挪到队尾：站点列表的顺序就是它的编号顺序
	const existing = getSites();
	const index = existing.findIndex((item) => item.id === site.id);
	const sites =
		index >= 0
			? existing.map((item, position) => (position === index ? site : item))
			: [...existing, site];
	await config().update("sites", sites, vscode.ConfigurationTarget.Global);
	await config().update("activeSiteId", site.id, vscode.ConfigurationTarget.Global);
	// 旧字段同步一份，方便老版本回退和手工查看
	await config().update("baseUrl", site.baseUrl, vscode.ConfigurationTarget.Global);
}

export async function removeSite(siteId: string, secrets: vscode.SecretStorage): Promise<void> {
	const previousActive = getActiveSiteId();
	const sites = getSites().filter((item) => item.id !== siteId);
	await config().update("sites", sites, vscode.ConfigurationTarget.Global);
	const byId = readModelsBySite();
	delete byId[siteId];
	await config().update("modelsBySite", byId, vscode.ConfigurationTarget.Global);
	await secrets.delete(`${SECRET_PREFIX}.${siteId}`);
	if (previousActive === siteId) {
		await config().update("activeSiteId", sites[0]?.id ?? "", vscode.ConfigurationTarget.Global);
	}
}

/** 旧版本把模型写在 models 里，这里做兼容读取。 */
function readModelsBySite(): Record<string, ModelEntry[]> {
	const raw = config().get<unknown>("modelsBySite", {});
	const result: Record<string, ModelEntry[]> = {};
	if (raw && typeof raw === "object") {
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			result[key] = normalizeModels(value);
		}
	}
	if (Object.keys(result).length === 0) {
		const legacy = normalizeModels(config().get<unknown>("models", []));
		if (legacy.length > 0) {
			result[LEGACY_SITE_ID] = legacy;
		}
	}
	return result;
}

function normalizeModels(raw: unknown): ModelEntry[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const entries: ModelEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id.trim() : "";
		if (!id) {
			continue;
		}
		const source =
			record.source === "models.dev" || record.source === "heuristic" ? record.source : "default";
		const storedName = typeof record.name === "string" && record.name ? record.name : id;
		entries.push({
			id,
			// 名字跟 id 一样说明是自动填的，顺手整理成展示格式；自己改过的名字不动
			name: storedName === id ? displayNameOf(id) : storedName,
			contextLength:
				typeof record.contextLength === "number" && record.contextLength > 0
					? record.contextLength
					: 128_000,
			toolCalling: record.toolCalling !== false,
			vision: record.vision === true,
			reasoning: record.reasoning === true,
			source,
			enabled: record.enabled !== false,
			apiMode: normalizeModelMode(record.apiMode, id),
			supportedEfforts: Array.isArray(record.supportedEfforts)
				? record.supportedEfforts.filter((value): value is string => typeof value === "string")
				: undefined,
			defaultEffort: typeof record.defaultEffort === "string" ? record.defaultEffort : undefined,
			effortMandatory: typeof record.effortMandatory === "boolean" ? record.effortMandatory : undefined,
			effortManual: record.effortManual === true ? true : undefined,
			temperature: typeof record.temperature === "number" ? record.temperature : undefined,
			topP: typeof record.topP === "number" ? record.topP : undefined,
			extra:
				record.extra && typeof record.extra === "object"
					? (record.extra as Record<string, unknown>)
					: undefined,
		});
	}
	return entries;
}

export function getModels(siteId: string): ModelEntry[] {
	return readModelsBySite()[siteId] ?? [];
}

export async function saveModels(siteId: string, models: ModelEntry[]): Promise<void> {
	const byId = readModelsBySite();
	byId[siteId] = models;
	await config().update("modelsBySite", byId, vscode.ConfigurationTarget.Global);
	// 旧字段同步一份，方便老版本回退和手工查看
	if (siteId === getActiveSiteId() || siteId === LEGACY_SITE_ID) {
		await config().update("models", models, vscode.ConfigurationTarget.Global);
	}
}

/** 只改一个模型的协议，其余模型保持原样。 */
export async function setModelProtocol(
	siteId: string,
	modelId: string,
	apiMode: ProtocolModeName
): Promise<ModelEntry | undefined> {
	const models = getModels(siteId);
	const target = models.find((model) => model.id === modelId);
	if (!target) {
		return undefined;
	}
	target.apiMode = normalizeModelMode(apiMode, modelId);
	await saveModels(siteId, models);
	return target;
}

/**
 * 记下某条线路实测不接受的字段。
 *
 * 只做加法：上游一旦拒过某个参数，下次就不带它，省掉那一轮失败重发。
 * 这些标记不在刷新时保留（扫描重建模型列表会自然丢掉），
 * 所以线路改好了、或者换了一家中转，刷新一次就重新尝试。
 */
export async function markModelUnsupported(
	siteId: string,
	modelId: string,
	field: "thinking" | "tools"
): Promise<void> {
	const models = getModels(siteId);
	const target = models.find((model) => model.id === modelId);
	if (!target) {
		return;
	}
	if (field === "thinking") {
		target.thinkingUnsupported = true;
	} else {
		target.toolUnsupported = true;
	}
	await saveModels(siteId, models);
}

export async function getApiKey(secrets: vscode.SecretStorage, siteId: string): Promise<string | undefined> {	const own = await secrets.get(`${SECRET_PREFIX}.${siteId}`);
	if (own && own.trim()) {
		return own.trim();
	}
	// 只有迁移来的默认站点才回退旧版单站点密钥，避免多站点之间串用
	if (siteId !== LEGACY_SITE_ID) {
		return undefined;
	}
	const legacy = await secrets.get(LEGACY_SECRET);
	return legacy && legacy.trim() ? legacy.trim() : undefined;
}

export async function saveApiKey(
	secrets: vscode.SecretStorage,
	siteId: string,
	apiKey: string
): Promise<void> {
	if (apiKey.trim()) {
		await secrets.store(`${SECRET_PREFIX}.${siteId}`, apiKey.trim());
	}
}

/** 只用于界面回显，不泄露完整密钥。 */
export function maskKey(key: string | undefined): string {
	if (!key) {
		return "";
	}
	if (key.length <= 8) {
		return "••••";
	}
	return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export { LEGACY_SITE_ID };
