import * as vscode from "vscode";

/**
 * 用真实用量校准「多少字符约等于一个 token」。
 *
 * 中英混排、各家 tokenizer 差异都很大，写死系数永远不准。每拿到一次上游的
 * prompt_tokens，就用这次请求的实际字符数反推一个观测值，再按 0.7 旧 + 0.3 新
 * 平滑，越用越贴近这条线路的真实分词。系数存进 globalState，重启也还在。
 */
const STORE_KEY = "ucantransit.charsPerToken";
const DEFAULT_RATIO = 2.6;
const MIN_RATIO = 0.6;
const MAX_RATIO = 8;

export class TokenRatio {
	constructor(private readonly state: vscode.Memento) {}

	/** 当前系数（每 token 多少字符）。 */
	get(): number {
		const stored = this.state.get<number>(STORE_KEY);
		return typeof stored === "number" && stored > 0 ? stored : DEFAULT_RATIO;
	}

	/** 拿到真实用量后更新系数；观测值离群太远就不采信。 */
	async observe(chars: number, promptTokens: number): Promise<void> {
		if (chars <= 0 || promptTokens <= 0) {
			return;
		}
		const observed = chars / promptTokens;
		if (!Number.isFinite(observed) || observed < MIN_RATIO || observed > MAX_RATIO) {
			return;
		}
		const next = this.get() * 0.7 + observed * 0.3;
		await this.state.update(STORE_KEY, Number(next.toFixed(3)));
	}

	estimate(text: string): number {
		if (!text) {
			return 1;
		}
		return Math.max(1, Math.ceil(text.length / this.get()));
	}
}
