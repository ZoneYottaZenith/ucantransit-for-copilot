import * as vscode from "vscode";

/**
 * 统一的上报出口。
 *
 * 思考内容用的是 chatProvider 提案里的 LanguageModelThinkingPart，
 * 稳定版如果还没暴露这个类，就退化成不显示，绝不因为缺一个类而让整条请求失败。
 */
export class Reporter {
	private wrote = false;

	constructor(private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>) {}

	/** 已经给 Copilot 送过内容。已经输出一半就不好再换协议重试了。 */
	get hasOutput(): boolean {
		return this.wrote;
	}

	text(value: string): void {
		if (!value) {
			return;
		}
		this.wrote = true;
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
}
