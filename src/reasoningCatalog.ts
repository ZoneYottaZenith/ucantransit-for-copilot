import * as vscode from "vscode";
import { fetchWithRetry } from "./http";

/**
 * 思考强度档位。
 *
 * 唯一公开给出档位的来源是 OpenRouter 的模型目录（supported_efforts / default_effort），
 * models.dev 只有“是否支持推理”的布尔值。拉不到就整体降级：只显示推理标签，不给下拉。
 * 结果缓存 24 小时，失败时继续用旧缓存，绝不阻塞主流程。
 */

const SOURCE_URL = "https://openrouter.ai/api/v1/models";
const CACHE_FILE = "reasoning-efforts.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReasoningInfo {
	efforts: string[];
	defaultEffort?: string;
	mandatory: boolean;
}

interface CacheShape {
	fetchedAt: number;
	models: Record<string, ReasoningInfo>;
}

function normalizeId(id: string): string {
	return id.trim().toLowerCase();
}

export class ReasoningCatalog {
	private constructor(private readonly models: Map<string, ReasoningInfo>) {}

	/** 数据未就绪时的空实例。 */
	static empty(): ReasoningCatalog {
		return new ReasoningCatalog(new Map());
	}

	get size(): number {
		return this.models.size;
	}

	find(modelId: string): ReasoningInfo | undefined {
		const id = normalizeId(modelId);
		if (!id) {
			return undefined;
		}
		const name = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
		return (
			this.models.get(id) ??
			this.models.get(id.split(":")[0]) ??
			this.models.get(name) ??
			this.models.get(name.split(":")[0])
		);
	}

	private static toMap(raw: unknown): Map<string, ReasoningInfo> {
		const map = new Map<string, ReasoningInfo>();
		const list = (raw as { data?: unknown })?.data;
		if (!Array.isArray(list)) {
			return map;
		}
		for (const item of list) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const record = item as Record<string, unknown>;
			const id = typeof record.id === "string" ? normalizeId(record.id) : "";
			if (!id) {
				continue;
			}
			const reasoning = record.reasoning as Record<string, unknown> | undefined;
			const effortsRaw = reasoning?.supported_efforts;
			const efforts = Array.isArray(effortsRaw)
				? effortsRaw.filter((value): value is string => typeof value === "string")
				: [];
			const info: ReasoningInfo = {
				efforts,
				defaultEffort:
					typeof reasoning?.default_effort === "string" ? (reasoning.default_effort as string) : undefined,
				mandatory: reasoning?.mandatory === true,
			};
			map.set(id, info);
			const name = id.slice(id.lastIndexOf("/") + 1);
			if (name && !map.has(name)) {
				map.set(name, info);
			}
		}
		return map;
	}

	private static cachePath(context: vscode.ExtensionContext): vscode.Uri {
		return vscode.Uri.joinPath(context.globalStorageUri, CACHE_FILE);
	}

	private static async readCache(context: vscode.ExtensionContext): Promise<CacheShape | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(ReasoningCatalog.cachePath(context));
			const parsed = JSON.parse(new TextDecoder().decode(bytes)) as CacheShape;
			if (parsed && typeof parsed === "object" && parsed.models) {
				return parsed;
			}
		} catch {
			// 没有缓存是正常情况
		}
		return undefined;
	}

	private static async writeCache(context: vscode.ExtensionContext, cache: CacheShape): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(context.globalStorageUri);
			const data = new TextEncoder().encode(JSON.stringify(cache));
			await vscode.workspace.fs.writeFile(ReasoningCatalog.cachePath(context), data);
		} catch {
			// 写缓存失败不影响使用
		}
	}

	private static async fetchRemote(tag: string): Promise<Map<string, ReasoningInfo> | undefined> {
		try {
			const response = await fetchWithRetry({
				url: SOURCE_URL,
				init: { method: "GET", headers: { Accept: "application/json", "User-Agent": tag } },
				timeoutMs: 20_000,
				retry: false,
			});
			if (!response.ok) {
				return undefined;
			}
			return ReasoningCatalog.toMap(await response.json());
		} catch {
			return undefined;
		}
	}

	/**
	 * 先给缓存，再决定要不要后台刷新；返回的实例始终可用（没有数据就是个空目录）。
	 */
	static async load(context: vscode.ExtensionContext, tag: string): Promise<ReasoningCatalog> {
		const cache = await ReasoningCatalog.readCache(context);
		const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;

		if (cache && fresh) {
			return new ReasoningCatalog(new Map(Object.entries(cache.models)));
		}

		const remote = await ReasoningCatalog.fetchRemote(tag);
		if (remote && remote.size > 0) {
			const models: Record<string, ReasoningInfo> = {};
			for (const [key, value] of remote) {
				models[key] = value;
			}
			await ReasoningCatalog.writeCache(context, { fetchedAt: Date.now(), models });
			return new ReasoningCatalog(remote);
		}

		// 拉不到就用旧数据，实在没有就是空目录
		return new ReasoningCatalog(cache ? new Map(Object.entries(cache.models)) : new Map());
	}
}
