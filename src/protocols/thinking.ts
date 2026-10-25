/**
 * 各家中转站开思考的方式互不兼容，这里只认模型名，认不出的一个字段都不发。
 *
 * 判据是"这个模型族默认会不会思考"，而不是"这条线路支持什么"：
 * 认错了顶多被上游打回 400，各协议里都有去掉该字段重试的兜底。
 */
export type ThinkingFlavor = "deepseek" | "glm" | "kimi" | "qwen" | "gemini" | "none";

const SEP = "(^|[/:_\\-. ])";

export function thinkingFlavor(modelId: string): ThinkingFlavor {
	const id = modelId.toLowerCase();
	if (new RegExp(`${SEP}deepseek`).test(id)) {
		return "deepseek";
	}
	if (new RegExp(`${SEP}(glm|chatglm)`).test(id)) {
		return "glm";
	}
	if (new RegExp(`${SEP}(kimi|moonshot)`).test(id)) {
		return "kimi";
	}
	if (new RegExp(`(${SEP}qwen|${SEP}qwq|^qwq)`).test(id)) {
		return "qwen";
	}
	if (new RegExp(`${SEP}gemini`).test(id)) {
		return "gemini";
	}
	return "none";
}
