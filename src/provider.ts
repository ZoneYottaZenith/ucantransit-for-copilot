import * as vscode from "vscode";
import { getActiveSite, getApiKey, getModels, getSites, isEnabled, markModelUnsupported, setModelProtocol } from "./config";
import { Reporter } from "./report";
import { describeNetworkError } from "./http";
import { TokenRatio } from "./tokenRatio";
import { PROTOCOL_LABELS, guessProtocol, sendChat } from "./protocols";
import type { ChatRequest } from "./protocols";
import { safeJson } from "./protocols/types";
import type { ModelEntry, SiteEntry } from "./types";

const FAMILY = "ucantransit";

/** 思考强度的强弱顺序，用来把上游给的档位排成从左到右越来越强。 */
const EFFORT_RANK: Record<string, number> = {
	none: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

/** 档位说明，只在中文界面下作为悬停提示。 */
const EFFORT_DESCRIPTION: Record<string, string> = {
	none: "不思考，回答最快",
	minimal: "几乎不思考，适合简单补全",
	low: "轻量推理，适合快速编辑",
	medium: "日常使用的平衡档",
	high: "深度推理，适合复杂问题",
	xhigh: "更大的思考预算，速度更慢",
	max: "最大思考预算，速度最慢",
};

function isChinese(): boolean {
	return vscode.env.language.toLowerCase().startsWith("zh");
}

/** 认不出来的自定义档位排在最后，彼此之间保持上游给的原始顺序。 */
function effortRank(effort: string): number {
	return EFFORT_RANK[effort.toLowerCase()] ?? 100;
}

/** 标签直接用上游英文名，只把首字母大写。 */
function effortLabel(effort: string): string {
	return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function effortDescription(effort: string): string | undefined {
	return isChinese() ? EFFORT_DESCRIPTION[effort.toLowerCase()] : undefined;
}

/** 输出预算：够用又不至于撑爆上下文。 */
function outputBudget(contextLength: number): number {
	return Math.min(8192, Math.max(1024, Math.floor(contextLength / 8)));
}

/**
 * 请求体里该给多少输出额度。
 *
 * 模型自己声明了上限就照发；没有就返回 undefined，不发这个字段，
 * 交给上游按自己的默认值来。写死一个数只会把长回答提前截断，
 * 思考模型的思考内容也算在这个额度里。
 */
function requestOutputLimit(entry: ModelEntry | undefined): number | undefined {
	if (entry?.outputLength && entry.outputLength > 0) {
		return entry.outputLength;
	}
	return undefined;
}

/** 上下文长度写成人看的形式，超过一百万用 M。 */
function formatContext(contextLength: number): string {
	if (contextLength >= 1_000_000) {
		const value = contextLength / 1_000_000;
		return `${Number.isInteger(value) ? value : value.toFixed(1)}M 上下文`;
	}
	return `${Math.round(contextLength / 1000)}K 上下文`;
}

/** 选择器里的一句话说明：写人话，参数细节留给 tooltip。 */
function describe(entry: ModelEntry): string {
	const size = formatContext(entry.contextLength);
	const abilities: string[] = [];
	if (entry.vision) {
		abilities.push("看图片");
	}
	if (entry.toolCalling) {
		abilities.push("调工具");
	}
	if (entry.reasoning) {
		abilities.push("深度思考");
	}
	return abilities.length > 0 ? `${size} · 可${abilities.join("、")}` : size;
}

function describeTooltip(entry: ModelEntry, site: SiteEntry): string {
	// tooltip 按 Markdown 渲染，单个换行会被折叠，用空行分段
	return [
		`UCanTransit · ${site.name}（${site.baseUrl}）`,
		`协议：${PROTOCOL_LABELS[entry.apiMode]}`,
		`上下文：${entry.contextLength.toLocaleString()} tokens`,
		`工具调用：${entry.toolCalling ? "支持" : "不支持"}｜图片：${entry.vision ? "支持" : "不支持"}`,
	].join("\n\n");
}

/** 多站点时用这个分隔符把站点拼进模型 id，避免同名模型互相顶掉。 */
const SITE_SEPARATOR = "::";

function siteScopedId(siteId: string, modelId: string, scoped: boolean): string {
	return scoped ? `${siteId}${SITE_SEPARATOR}${modelId}` : modelId;
}

/**
 * 从选择器下发的 id 反查站点。
 * 模型 id 自身也可能带分隔符，所以只认“前缀确实是已知站点”的情况，其余退回当前站点。
 */
function resolveTarget(id: string): { site: SiteEntry; modelId: string } | undefined {
	const index = id.indexOf(SITE_SEPARATOR);
	if (index > 0) {
		const siteId = id.slice(0, index);
		const site = getSites().find((item) => item.id === siteId);
		if (site) {
			return { site, modelId: id.slice(index + SITE_SEPARATOR.length) };
		}
	}
	const active = getActiveSite();
	return active ? { site: active, modelId: id } : undefined;
}

/** 中英混排的粗略估算：汉字约 1.5 字符/token，其余约 4 字符/token。 */
function estimateTokens(text: string): number {
	if (!text) {
		return 1;
	}
	const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
	const rest = text.length - cjk;
	return Math.max(1, Math.ceil(cjk / 1.5 + rest / 4));
}

/**
 * 粗略统计这次请求发出的字符数，给 token 校准当分母。
 *
 * 图片不是文本，直接把 base64 算进去会把系数彻底带偏，所以跳过 DataPart。
 */
function countRequestChars(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	tools: readonly vscode.LanguageModelChatTool[] | undefined
): number {
	let total = 0;
	for (const message of messages) {
		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += part.value.length;
			} else if (typeof part === "string") {
				total += part.length;
			} else if (part instanceof vscode.LanguageModelDataPart) {
				continue;
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				total += (part.name ?? "").length + safeJson(part.input ?? {}).length;
			} else {
				// 工具结果等结构，按 JSON 长度算个大概
				total += safeJson(part).length;
			}
		}
	}
	for (const tool of tools ?? []) {
		total += tool.name.length + (tool.description ?? "").length + safeJson(tool.inputSchema ?? {}).length;
	}
	return total;
}

export function reasoningEffortFrom(options: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
	// 模型选择器下发的参数，稳定 API 里没有正式字段，按提案的几种写法读。
	// 请求级的 modelOptions 优先，其次是持久化的 modelConfiguration，最后是 configuration。
	const raw = options as unknown as {
		modelConfiguration?: Record<string, unknown>;
		configuration?: Record<string, unknown>;
		modelOptions?: Record<string, unknown>;
	};
	const value =
		raw.modelOptions?.reasoningEffort ?? raw.modelConfiguration?.reasoningEffort ?? raw.configuration?.reasoningEffort;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 把候选档位去重并按思考强度从弱到强排好。
 * “停用”只在上游明确说了思考可关时才加，且固定排在最左。
 */
function orderedChoices(entry: ModelEntry): string[] {
	const efforts = entry.supportedEfforts ?? [];
	if (efforts.length === 0) {
		return [];
	}
	const wanted = entry.effortMandatory === false ? ["none", ...efforts] : [...efforts];
	const unique: string[] = [];
	for (const effort of wanted) {
	if (!unique.includes(effort)) {
		unique.push(effort);
	}
	}
	return unique
		.map((effort, index) => ({ effort, index }))
		.sort((a, b) => effortRank(a.effort) - effortRank(b.effort) || a.index - b.index)
		.map((item) => item.effort);
}

/** 让模型选择器里出现“思考模式”下拉，只在拿到档位时才给。 */
export function configurationSchema(entry: ModelEntry): Record<string, unknown> | undefined {
	const choices = orderedChoices(entry);
	if (choices.length === 0) {
		return undefined;
	}
	const descriptions = choices.map((effort) => effortDescription(effort));
	// 上游没给默认档时优先选真实档位，不要一上来就停在“停用”
	const fallback = choices.find((effort) => effort !== "none") ?? choices[0];
	const configuredDefault =
		entry.defaultEffort && choices.includes(entry.defaultEffort) ? entry.defaultEffort : fallback;

	return {
		properties: {
			reasoningEffort: {
				type: "string",
				title: isChinese() ? "思考模式" : "Thinking",
				enum: choices,
				enumItemLabels: choices.map((effort) => effortLabel(effort)),
				...(descriptions.some((text) => Boolean(text)) ? { enumDescriptions: descriptions } : {}),
				default: configuredDefault,
				group: "navigation",
			},
		},
	};
}

/**
 * 把中转站模型挂到 Copilot 的模型选择器上。
 *
 * 关闭开关或没有配置时返回空列表，Copilot 恢复原样；
 * 配置变化通过 onDidChangeLanguageModelChatInformation 通知宿主，无需重载窗口。
 */
export class TransitModelProvider implements vscode.LanguageModelChatProvider {
	private readonly emitter = new vscode.EventEmitter<void>();

	readonly onDidChangeLanguageModelChatInformation = this.emitter.event;

	constructor(private readonly secrets: vscode.SecretStorage, globalState: vscode.Memento) {
		this.ratio = new TokenRatio(globalState);
	}

	/** 当前「每 token 多少字符」的校准系数。 */
	private readonly ratio: TokenRatio;

	refresh(): void {
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}

	async provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		if (!isEnabled()) {
			return [];
		}
		// 只有启用且真会输出模型的站点才算数，空站点/已停用的站点不该让 id 变来变去
		const contributing = getSites()
			.filter((site) => site.enabled !== false)
			.map((site) => ({ site, models: getModels(site.id).filter((entry) => entry.enabled !== false) }))
			.filter((item) => item.models.length > 0);
		// 只有一个站点时沿用纯模型 id，老用户已经选中的模型不会掉
		const scoped = contributing.length > 1;
		const result: vscode.LanguageModelChatInformation[] = [];

		for (const { site, models } of contributing) {
			// 读密钥只是用来标记“未配置”，失败不应拖垮整个模型列表
			let configured = false;
			try {
				configured = Boolean(await getApiKey(this.secrets, site.id));
			} catch {
				configured = false;
			}

			// 选择器里一眼看出模型属于哪个中转站
			const siteLabel = site.name || site.baseUrl;

			for (const entry of models) {
				const maxOutputTokens = outputBudget(entry.contextLength);
				const maxInputTokens = Math.max(1, entry.contextLength - maxOutputTokens);
				const detail = configured
					? `${siteLabel} · ${describe(entry)}`
					: `${siteLabel} · 未配置 API Key，打开 UCanTransit 面板填写`;
				const schema = configurationSchema(entry);

				result.push({
					id: siteScopedId(site.id, entry.id, scoped),
					// 选择器只渲染 name，detail 那行会被整条丢掉；
					// 行是按名称排序的，站点名必须在前面，同名模型才会聚在一起
					name: `[${siteLabel}] ${entry.name || entry.id}`,
					family: FAMILY,
					version: "1.0.0",
					detail,
					tooltip: describeTooltip(entry, site),
					...(configured ? {} : { statusIcon: new vscode.ThemeIcon("warning") }),
					maxInputTokens,
					maxOutputTokens,
					isUserSelectable: true,
					isBYOK: true,
					...(schema ? { configurationSchema: schema } : {}),
					capabilities: {
						toolCalling: entry.toolCalling,
						imageInput: entry.vision,
					},
				} satisfies vscode.LanguageModelChatInformation);
			}
		}

		return result;
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		// 模型 id 里带了站点前缀就从里面取，老配置没有前缀就退回当前站点
		const target = resolveTarget(model.id);
		if (!target) {
			throw new Error("UCanTransit 还没有配置中转站");
		}
		const { site, modelId } = target;
		const entry = getModels(site.id).find((item) => item.id === modelId);
		const apiKey = await getApiKey(this.secrets, site.id);
		if (!apiKey) {
			throw new Error("UCanTransit 缺少 API Key");
		}

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());
		const reporter = new Reporter(progress);
		// 模型自带协议；旧配置里没有就用模型名重新推一次
		const mode = entry?.apiMode ?? guessProtocol(modelId);

		const request: ChatRequest = {
			baseUrl: site.baseUrl,
			apiKey,
			modelId,
			messages,
			tools: options.tools,
			toolMode: options.toolMode,
			maxOutputTokens: requestOutputLimit(entry),
			temperature: entry?.temperature,
			topP: entry?.topP,
			reasoningEffort: reasoningEffortFrom(options) ?? entry?.defaultEffort,
			extra: entry?.extra,
			signal: controller.signal,
			reporter,
			thinkingUnsupported: entry?.thinkingUnsupported,
			toolUnsupported: entry?.toolUnsupported,
			// 上游拒了就记下来，下次这条线路不再带这个字段（刷新模型列表会清掉）
			onDowngrade: (field) => {
				void markModelUnsupported(site.id, modelId, field).then(() => this.refresh());
			},
			// 拿到真实用量就校准一次估算系数
			onUsage: (usage) => {
				void this.ratio.observe(countRequestChars(messages, options.tools), usage.promptTokens);
			},
		};

		try {
			try {
				await sendChat(mode, request);
			} catch (error) {
				// 猜的协议不一定等于这家中转站暴露的形态。只要还没往外吐过内容，
				// 就退回最通用的 Chat Completions 再试一次，并把结果记下来。
				const canFallback = mode !== "openai" && !reporter.hasOutput && Boolean(entry);
				if (!canFallback || token.isCancellationRequested) {
					throw error;
				}
				await sendChat("openai", { ...request, reporter: new Reporter(progress) });
				await setModelProtocol(site.id, modelId, "openai");
				this.refresh();
			}
		} catch (error) {
			if (token.isCancellationRequested) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			const hint = describeNetworkError(error);
			throw new Error(hint ? `UCanTransit 请求失败：${hint}（${message}）` : `UCanTransit 请求失败：${message}`);
		} finally {
			cancellation.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage
	): Promise<number> {
		if (typeof text === "string") {
			return this.ratio.estimate(text);
		}
		let total = 0;
		for (const part of text.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += this.ratio.estimate(part.value);
			} else if (typeof part === "string") {
				total += this.ratio.estimate(part);
			}
		}
		return Math.max(1, total);
	}
}
