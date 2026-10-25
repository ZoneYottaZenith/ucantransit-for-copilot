import type { ModelEntry, ProtocolModeName } from "./types";
import type { ModelsDevCatalog } from "./modelsDev";
import type { ReasoningCatalog } from "./reasoningCatalog";
import { displayNameOf } from "./displayName";
import { guessProtocol } from "./protocols";

/**
 * 模型发现：问中转站有哪些模型，并尽量把能力和档位填对。
 *
 * 能力顺序固定：models.dev 快照 → 名称关键词 → 保守默认。
 * 图片能力不猜：猜错的代价是用户一发图就失败。
 *
 * 协议跟站点无关：拿到名单后逐个按模型名推断，面板里还能单独改。
 */

const DEFAULT_CONTEXT = 128_000;
const REQUEST_TIMEOUT_MS = 20_000;

const VISION_PATTERN =
	/(^|[-_/.:])(vl|vision|omni|llava|pixtral|internvl)([-_/.:]|$)|gpt-4o|gpt-4\.1|gpt-4-v|qwen[\w.-]*vl|glm-4v|grok[\w.-]*vision|gemini/i;

const REASONING_PATTERN =
	/(^|[-_/.:])o[1-9]($|[-_/.:])|reason|thinking|think\b|deepseek-r|qwq|r1\b|gpt-5|glm-5/i;

export interface ScanResult {
	models: ModelEntry[];
	/** 实际拿到名单的端点，仅用于在面板里说明探测结果。 */
	endpoint: string;
	warning?: string;
}

/**
 * 把 source 模型的思考档位套到 target 上；source 为空表示清除手动套用的档位。
 *
 * 中转站经常自己改名（同一个模型换个 id），导致匹配不到档位。
 * 用户看得出是同一个模型，就让他手动指定从哪个模型继承。
 */
export function withEffortsFrom(target: ModelEntry, source: ModelEntry | undefined): ModelEntry {
	if (!source || !source.supportedEfforts || source.supportedEfforts.length === 0) {
		const cleared: ModelEntry = { ...target };
		delete cleared.supportedEfforts;
		delete cleared.defaultEffort;
		delete cleared.effortMandatory;
		delete cleared.effortManual;
		return cleared;
	}
	return {
		...target,
		supportedEfforts: [...source.supportedEfforts],
		defaultEffort: source.defaultEffort,
		effortMandatory: source.effortMandatory,
		effortManual: true,
		reasoning: true,
	};
}

/**
 * 把新扫到的结果和已有配置合并。
 *
 * 分工很简单：上游说的算事实，用户选的算偏好。
 * - 上下文、能力、思考档位：以上游这次给的为准（这些本来就会变）
 * - 启停、协议、温度、top_p、额外字段：只要用户留过就保留
 * - 手动套用过来的档位：上游给不出有效档位，保留用户的
 * - 新出现的模型：全套用默认值
 * - 上游已经下架的模型：从列表里去掉
 */
export function mergeModels(previous: ModelEntry[], scanned: ModelEntry[]): ModelEntry[] {
	const byId = new Map(previous.map((entry) => [entry.id, entry]));
	return scanned.map((fresh) => {
		const old = byId.get(fresh.id);
		if (!old) {
			return fresh;
		}
		const keepManualEfforts = old.effortManual === true && Boolean(old.supportedEfforts?.length);
		return {
			...fresh,
			enabled: old.enabled !== false,
			apiMode: old.apiMode,
			temperature: old.temperature,
			topP: old.topP,
			extra: old.extra,
			...(keepManualEfforts
				? {
						supportedEfforts: old.supportedEfforts,
						defaultEffort: old.defaultEffort,
						effortMandatory: old.effortMandatory,
						effortManual: true,
						reasoning: true,
					}
				: {}),
		};
	});
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/** 模型列表端点的候选形态：OpenAI 系、Anthropic、Gemini 各一套。 */
function modelsUrls(baseUrl: string, mode: ProtocolModeName): string[] {
	const base = trimTrailingSlash(baseUrl);
	if (mode === "gemini") {
		const withVersion = /\/v\d+(alpha|beta)?\d*$/i.test(base) ? base : `${base}/v1beta`;
		return [`${withVersion}/models`];
	}
	const primary = /\/v\d+$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
	const fallback = `${base}/models`;
	return primary === fallback ? [primary] : [primary, fallback];
}

function headersFor(mode: ProtocolModeName, apiKey: string): Record<string, string> {
	if (mode === "anthropic") {
		return {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			Accept: "application/json",
		};
	}
	if (mode === "gemini") {
		return { "x-goog-api-key": apiKey, Accept: "application/json" };
	}
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

async function request(url: string, mode: ProtocolModeName, apiKey: string): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, { method: "GET", headers: headersFor(mode, apiKey), signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** 兼容 {data:[]}、{models:[]}、裸数组；Gemini 的 name 是 models/xxx，需要去掉前缀。 */
function extractIds(payload: unknown): string[] {
	const collect = (list: unknown): string[] => {
		if (!Array.isArray(list)) {
			return [];
		}
		const ids: string[] = [];
		for (const item of list) {
			if (typeof item === "string") {
				ids.push(item);
				continue;
			}
			if (!item || typeof item !== "object") {
				continue;
			}
			const record = item as Record<string, unknown>;
			const id = record.id ?? record.name ?? record.model;
			if (typeof id === "string" && id.trim()) {
				ids.push(id.trim().replace(/^models\//i, ""));
			}
		}
		return ids;
	};

	if (Array.isArray(payload)) {
		return collect(payload);
	}
	if (payload && typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		return [...collect(record.data), ...collect(record.models)];
	}
	return [];
}

function heuristic(modelId: string): { vision: boolean; reasoning: boolean } {
	return {
		vision: VISION_PATTERN.test(modelId),
		reasoning: REASONING_PATTERN.test(modelId),
	};
}

function toEntry(
	modelId: string,
	catalog: ModelsDevCatalog | undefined,
	reasoning: ReasoningCatalog | undefined
): ModelEntry {
	const info = catalog?.find(modelId);
	const guess = heuristic(modelId);
	const efforts = reasoning?.find(modelId);

	const base: ModelEntry = {
		id: modelId,
		name: displayNameOf(modelId),
		contextLength: info?.contextLength && info.contextLength > 0 ? info.contextLength : DEFAULT_CONTEXT,
		toolCalling: info ? info.toolCalling : true,
		vision: info ? info.inputImage : guess.vision,
		reasoning: info ? info.reasoning : guess.reasoning,
		source: info ? "models.dev" : guess.vision || guess.reasoning ? "heuristic" : "default",
		enabled: true,
		apiMode: guessProtocol(modelId),
	};

	if (efforts && efforts.efforts.length > 0) {
		base.supportedEfforts = efforts.efforts;
		base.defaultEffort = efforts.defaultEffort;
		base.effortMandatory = efforts.mandatory;
		base.reasoning = true;
	}
	return base;
}

/**
 * 连接中转站并拉取模型列表。
 *
 * 只做一件事：拿到有哪些模型。协议不在这里定，后面按模型名逐个推。
 * 三种列表形态依次试：OpenAI 系 → Anthropic → Gemini。
 */
export async function scanModels(
	baseUrl: string,
	apiKey: string,
	catalog: ModelsDevCatalog | undefined,
	options?: { reasoning?: ReasoningCatalog }
): Promise<ScanResult> {
	if (!/^https?:\/\//i.test(baseUrl)) {
		throw new Error("地址需要以 http:// 或 https:// 开头");
	}

	const modes: ProtocolModeName[] = ["openai", "anthropic", "gemini"];
	let lastError: Error | undefined;

	for (const mode of modes) {
		for (const url of modelsUrls(baseUrl, mode)) {
			try {
				const response = await request(url, mode, apiKey);
				if (!response.ok) {
					lastError = new Error(
						`请求失败（HTTP ${response.status}）${(await response.text().catch(() => "")).slice(0, 200)}`
					);
					continue;
				}
				const ids = Array.from(new Set(extractIds(await response.json())));
				if (ids.length === 0) {
					lastError = new Error("接口没有返回任何模型，请确认地址是否指向中转站根路径");
					continue;
				}

				const models = ids
					.map((id) => toEntry(id, catalog, options?.reasoning))
					.sort((a, b) => a.id.localeCompare(b.id));

				const unknown = models.filter((model) => model.source !== "models.dev").length;
				const withEfforts = models.filter((model) => (model.supportedEfforts?.length ?? 0) > 0).length;
				const notes: string[] = [];
				if (unknown > 0) {
					notes.push(`${unknown} 个模型缺少能力数据，已按名称规则或默认值处理`);
				}
				if (withEfforts > 0) {
					notes.push(`${withEfforts} 个模型拿到思考档位`);
				}

				return {
					models,
					endpoint: url,
					warning: notes.length > 0 ? `${notes.join("；")}。` : undefined,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
			}
		}
	}

	throw lastError ?? new Error("无法连接到中转站");
}
