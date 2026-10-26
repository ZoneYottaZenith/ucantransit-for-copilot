import * as vscode from "vscode";

/** Copilot 认可的用量上报 MIME，和 04 项目用法一致。 */
const USAGE_MIME = "usage";

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedTokens?: number;
}

/**
 * 从上游的 usage 字段里取值。
 *
 * 各家中转站字段名不统一（prompt_tokens / input_tokens、cached_tokens 位置也不同），
 * 认得出哪个用哪个，一个都认不出就返回 undefined。
 */
export function readUsage(raw: unknown): TokenUsage | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	const record = raw as Record<string, unknown>;
	const num = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

	const promptTokens = num(record.prompt_tokens) ?? num(record.input_tokens);
	const completionTokens = num(record.completion_tokens) ?? num(record.output_tokens);
	const totalTokens =
		num(record.total_tokens) ??
		(promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
	if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
		return undefined;
	}

	const details = record.prompt_tokens_details as Record<string, unknown> | undefined;
	return {
		promptTokens: promptTokens ?? 0,
		completionTokens: completionTokens ?? 0,
		totalTokens: totalTokens ?? 0,
		cachedTokens: num(record.prompt_cache_hit_tokens) ?? num(details?.cached_tokens),
	};
}

/**
 * 统一的上报出口。
 *
 * 思考内容用的是 chatProvider 提案里的 LanguageModelThinkingPart，
 * 稳定版如果还没暴露这个类，就退化成不显示，绝不因为缺一个类而让整条请求失败。
 */
export class Reporter {
	private wrote = false;
	private textWrote = false;

	constructor(private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>) {}

	/** 已经给 Copilot 送过内容。已经输出一半就不好再换协议重试了。 */
	get hasOutput(): boolean {
		return this.wrote;
	}

	/** 已经送过正文（不算思考）。工具调用前要靠它决定要不要补个空格。 */
	get hasText(): boolean {
		return this.textWrote;
	}

	text(value: string): void {
		if (!value) {
			return;
		}
		this.wrote = true;
		this.textWrote = true;
		this.progress.report(new vscode.LanguageModelTextPart(value));
	}

	/**
	 * 思考增量。
	 *
	 * 只传正文、不塞自造的 id：VS Code 会把连续的 thinking part 拼成一块，
	 * 多传一个 id 反而可能被当成另一段思考。
	 */
	thinking(value: string): void {
		if (!value) {
			return;
		}
		const ThinkingPart = (vscode as unknown as { LanguageModelThinkingPart?: new (value: string | string[]) => unknown })
			.LanguageModelThinkingPart;
		if (!ThinkingPart) {
			return;
		}
		this.wrote = true;
		this.progress.report(new ThinkingPart(value) as never);
	}

	toolCall(id: string, name: string, input: Record<string, unknown>): void {
		this.wrote = true;
		this.progress.report(new vscode.LanguageModelToolCallPart(id, name, input));
	}

	/**
	 * 把真实 token 用量报给 Copilot，它用来显示上下文占用。
	 *
	 * 不置 wrote：用量不算内容输出，不能影响「已经吐过东西就不再换协议」的判断。
	 */
	usage(value: TokenUsage | undefined): void {
		if (!value) {
			return;
		}
		const DataPart = (
			vscode as unknown as {
				LanguageModelDataPart?: new (data: Uint8Array, mimeType: string) => unknown;
			}
		).LanguageModelDataPart;
		if (!DataPart) {
			return;
		}
		const payload = {
			prompt_tokens: value.promptTokens,
			completion_tokens: value.completionTokens,
			total_tokens: value.totalTokens,
			prompt_tokens_details: { cached_tokens: value.cachedTokens ?? 0 },
		};
		try {
			this.progress.report(
				new DataPart(new TextEncoder().encode(JSON.stringify(payload)), USAGE_MIME) as never
			);
		} catch {
			// 老版本 VS Code 没这个 part，静默跳过，不影响对话
		}
	}
}
