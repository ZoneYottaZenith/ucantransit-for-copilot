import * as vscode from "vscode";

/**
 * models.dev 快照的读取与索引。
 *
 * 结构与 rikkahub 的做法一致：同一个模型会散落在多个 provider 下，id 写法也不统一
 * （`claude-sonnet-4-5`、`anthropic/claude-sonnet-4.5`），所以按完整 id、去前缀名、
 * canonical id 三种写法建索引，同一个 key 命中多条时按多数投票合并。
 * 平票视为支持——各家数据普遍漏标能力，漏标比错标代价小。
 */

export interface ModelInfo {
	inputImage: boolean;
	outputImage: boolean;
	toolCalling: boolean;
	reasoning: boolean;
	contextLength?: number;
}

interface RawModel {
	modalities?: { input?: string[]; output?: string[] };
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: { context?: number };
	canonical_model_id?: string;
}

function afterLast(value: string, separator: string): string {
	const index = value.lastIndexOf(separator);
	return index < 0 ? value : value.slice(index + separator.length);
}

interface Votes {
	total: number;
	imageInput: number;
	imageOutput: number;
	tool: number;
	reasoning: number;
	contexts: Map<number, number>;
}

class ModelVotes implements Votes {
	total = 0;
	imageInput = 0;
	imageOutput = 0;
	tool = 0;
	reasoning = 0;
	contexts = new Map<number, number>();

	add(model: RawModel): void {
		this.total += 1;
		if (model.modalities?.input?.includes("image")) {
			this.imageInput += 1;
		}
		if (model.modalities?.output?.includes("image")) {
			this.imageOutput += 1;
		}
		if (model.tool_call) {
			this.tool += 1;
		}
		if (model.reasoning) {
			this.reasoning += 1;
		}
		const context = model.limit?.context;
		if (typeof context === "number" && context > 0) {
			this.contexts.set(context, (this.contexts.get(context) ?? 0) + 1);
		}
	}

	private majority(count: number): boolean {
		return count * 2 >= this.total;
	}

	toInfo(): ModelInfo {
		let bestContext: number | undefined;
		let bestCount = 0;
		for (const [value, count] of this.contexts) {
			// 先比票数，票数相同取更大的窗口
			if (count > bestCount || (count === bestCount && bestContext !== undefined && value > bestContext)) {
				bestContext = value;
				bestCount = count;
			}
		}
		return {
			inputImage: this.majority(this.imageInput),
			outputImage: this.majority(this.imageOutput),
			toolCalling: this.majority(this.tool),
			reasoning: this.majority(this.reasoning),
			contextLength: bestContext,
		};
	}
}

export class ModelsDevCatalog {
	private constructor(private readonly index: Map<string, ModelInfo>) {}

	get size(): number {
		return this.index.size;
	}

	/**
	 * 模糊兜底：模型 id 里包含了哪个官方 id 就算命中，并且取最长的那个。
	 * 中转站常给官方模型加后缀（`gpt-4o-优化版`），精确查表查不到，但语义上就是同一个模型；
	 * 取最长是为了让 `gpt-4o-mini-优化版` 命中 `gpt-4o-mini` 而不是更短的 `gpt-4o`。
	 */
	private fuzzy(id: string): ModelInfo | undefined {
		let bestKey = "";
		let best: ModelInfo | undefined;
		for (const [key, info] of this.index) {
			// 太短的 key 容易误命中，直接跳过
			if (key.length < 4 || key.length <= bestKey.length) {
				continue;
			}
			if (id.includes(key)) {
				bestKey = key;
				best = info;
			}
		}
		return best;
	}

	/** 支持 `vendor/model`、`model`、带 `:free` 后缀等写法，查不到再做模糊匹配。 */
	find(modelId: string): ModelInfo | undefined {
		const id = modelId.trim().toLowerCase();
		if (!id) {
			return undefined;
		}
		const name = afterLast(id, "/");
		const exact =
			this.index.get(id) ??
			this.index.get(id.split(":")[0]) ??
			this.index.get(name) ??
			this.index.get(name.split(":")[0]);
		return exact ?? this.fuzzy(id);
	}

	static fromJson(text: string): ModelsDevCatalog {
		const providers = JSON.parse(text) as Record<string, { models?: Record<string, RawModel> }>;
		const votes = new Map<string, ModelVotes>();

		for (const provider of Object.values(providers)) {
			for (const [id, model] of Object.entries(provider.models ?? {})) {
				const keys = new Set<string>();
				const lower = id.toLowerCase();
				keys.add(lower);
				keys.add(afterLast(lower, "/"));
				const canonical = model.canonical_model_id?.toLowerCase();
				if (canonical) {
					keys.add(canonical);
					keys.add(afterLast(canonical, "/"));
				}
				for (const key of keys) {
					if (!key) {
						continue;
					}
					let bucket = votes.get(key);
					if (!bucket) {
						bucket = new ModelVotes();
						votes.set(key, bucket);
					}
					bucket.add(model);
				}
			}
		}

		const index = new Map<string, ModelInfo>();
		for (const [key, bucket] of votes) {
			index.set(key, bucket.toInfo());
		}
		return new ModelsDevCatalog(index);
	}

	/** 只读一次，之后走缓存。失败返回 undefined，不影响主流程。 */
	static async load(extensionUri: vscode.Uri): Promise<ModelsDevCatalog | undefined> {
		if (!ModelsDevCatalog.loading) {
			ModelsDevCatalog.loading = (async () => {
				try {
					const file = vscode.Uri.joinPath(extensionUri, "media", "models_dev.json");
					const bytes = await vscode.workspace.fs.readFile(file);
					return ModelsDevCatalog.fromJson(new TextDecoder().decode(bytes));
				} catch {
					return undefined;
				}
			})();
		}
		return ModelsDevCatalog.loading;
	}

	private static loading: Promise<ModelsDevCatalog | undefined> | undefined;
}
