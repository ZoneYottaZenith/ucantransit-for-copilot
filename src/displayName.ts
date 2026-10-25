/**
 * 模型展示名。
 *
 * 中转站给的是机器用的 id（`gpt-5.5`、`deepseek-v3`），直接摆进选择器很难看。
 * 这里只做「大小写整理」：id 一个字不改，只把名字排得像人写的。
 * 认不出的部分宁可保守，也不能把 id 改错。
 */

/** 该全大写的缩写。 */
const ACRONYMS = new Set([
	"gpt",
	"vl",
	"vlm",
	"mllm",
	"llm",
	"moe",
	"tts",
	"asr",
	"ocr",
	"api",
	"glm",
	"it",
	"id",
	"sdk",
]);

/** 品牌名有固定的写法，逐个列出来比通用规则靠谱。 */
const BRANDS: Record<string, string> = {
	openai: "OpenAI",
	deepseek: "DeepSeek",
	microsoft: "Microsoft",
	google: "Google",
	meta: "Meta",
	mistral: "Mistral",
	moonshot: "Moonshot",
	zhipu: "Zhipu",
	alibaba: "Alibaba",
	baidu: "Baidu",
	claude: "Claude",
	gemini: "Gemini",
	gemma: "Gemma",
	qwen: "Qwen",
	llama: "Llama",
	grok: "Grok",
	kimi: "Kimi",
	doubao: "Doubao",
	ernie: "ERNIE",
	phi: "Phi",
	yi: "Yi",
	sonnet: "Sonnet",
	opus: "Opus",
	haiku: "Haiku",
	turbo: "Turbo",
	mini: "Mini",
	nano: "Nano",
};

const SEPARATOR = /^([/:_\-.\s]+)$/;

function capitalize(part: string): string {
	const lower = part.toLowerCase();
	const brand = BRANDS[lower];
	if (brand) {
		return brand;
	}
	if (ACRONYMS.has(lower)) {
		return lower.toUpperCase();
	}
	// 本来就是全大写的不去动它（MODEL-IN-CAPS、ERNIE 这类）
	if (part.length > 1 && part === part.toUpperCase() && /[A-Z]/.test(part)) {
		return part;
	}
	// 纯版本号（5.5、3）和以数字开头的型号（4o、72b）原样保留
	if (/^\d/.test(part)) {
		return part;
	}
	return part.charAt(0).toUpperCase() + part.slice(1);
}

/** 把模型 id 整理成适合展示的名字，分隔符与顺序都不动。 */
export function displayNameOf(modelId: string): string {
	const id = modelId.trim();
	if (!id) {
		return "";
	}
	return id
		.split(/([/:_\-.\s]+)/)
		.map((part) => (part && !SEPARATOR.test(part) ? capitalize(part) : part))
		.join("");
}
