/**
 * 思考开关自检：各个厂商的"开思考"字段有没有按要求发出去，
 * 以及上游拒收时会不会自动去掉重试、思考 part 有没有多带 id。
 * 全部走本地随机端口，不联网、不改系统。
 *
 * 运行：node 测试脚本/思考开关自检.js
 */

const http = require("node:http");
const path = require("node:path");
const Module = require("node:module");

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
class LanguageModelThinkingPart {
	constructor(value, id) {
		this.value = value;
		this.id = id;
	}
}

const vscodeMock = {
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelDataPart,
	LanguageModelThinkingPart,
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	LanguageModelChatToolMode: { Auto: 1, Required: 2 },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeMock;
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const { sendChat } = require(path.join(outDir, "protocols", "index.js"));
const { thinkingFlavor } = require(path.join(outDir, "protocols", "thinking.js"));
const { Reporter } = require(path.join(outDir, "report.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

function sse(events) {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function startServer(handler) {
	return new Promise((resolve) => {
		const requests = [];
		const server = http.createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => (raw += chunk));
			req.on("end", () => {
				let body = null;
				try {
					body = JSON.parse(raw);
				} catch {
					body = raw;
				}
				requests.push({ url: req.url, body });
				const reply = handler(req.url, body, requests.length);
				if (reply.sse !== undefined) {
					res.writeHead(200, { "Content-Type": "text/event-stream" });
					res.end(reply.sse);
				} else {
					res.writeHead(reply.status ?? 500, { "Content-Type": "application/json" });
					res.end(JSON.stringify(reply.body ?? {}));
				}
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
	});
}

async function send(mode, port, modelId, extra = {}) {
	const parts = [];
	const progress = {
		report(part) {
			parts.push(part);
		},
	};
	await sendChat(mode, {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "test-key",
		modelId,
		messages: [{ role: 1, content: [new LanguageModelTextPart("你好")] }],
		maxOutputTokens: 512,
		signal: new AbortController().signal,
		reporter: new Reporter(progress),
		...extra,
	});
	return { parts, body: null };
}

async function main() {
	// ---------- 厂商识别 ----------
	check("deepseek 识别", thinkingFlavor("deepseek-chat") === "deepseek");
	check("deepseek 带前缀也识别", thinkingFlavor("vendor/deepseek-r1") === "deepseek");
	check("glm 识别", thinkingFlavor("glm-4.6") === "glm");
	check("kimi 识别", thinkingFlavor("kimi-k2-thinking") === "kimi");
	check("qwen 识别", thinkingFlavor("qwen3-max") === "qwen");
	check("qwq 识别", thinkingFlavor("qwq-plus") === "qwen");
	check("gemini 识别", thinkingFlavor("gemini-2.5-pro") === "gemini");
	check("gemma 不算 gemini", thinkingFlavor("gemma-3-27b") === "none");
	check("claude 不在 chat 注入范围", thinkingFlavor("claude-sonnet-4") === "none");
	check("无关模型不认", thinkingFlavor("my-private-model") === "none");

	// ---------- Chat Completions：认得出就默认开 ----------
	const openai = await startServer(() => ({
		sse: sse([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]),
	}));
	const cases = [
		["deepseek-chat", "thinking", "enabled"],
		["glm-4.6", "thinking", "enabled"],
		["kimi-k2-thinking", "thinking", "enabled"],
	];
	for (const [modelId, field, value] of cases) {
		const before = openai.requests.length;
		await send("openai", openai.port, modelId);
		const body = openai.requests[before].body;
		check(`${modelId} 发 ${field}.type=${value}`, body[field]?.type === value, JSON.stringify(body[field]));
	}

	const beforeQwen = openai.requests.length;
	await send("openai", openai.port, "qwen3-max");
	check(
		"qwen3-max 发 enable_thinking=true",
		openai.requests[beforeQwen].body.enable_thinking === true,
		JSON.stringify(openai.requests[beforeQwen].body.enable_thinking)
	);
	check(
		"qwen3-max 不带 thinking 对象",
		!("thinking" in openai.requests[beforeQwen].body)
	);

	const beforeUnknown = openai.requests.length;
	await send("openai", openai.port, "my-private-model");
	check(
		"认不出的模型一个字段都不加",
		!("thinking" in openai.requests[beforeUnknown].body) &&
			!("enable_thinking" in openai.requests[beforeUnknown].body)
	);

	// ---------- 用户选 None 就发关 ----------
	const beforeNone = openai.requests.length;
	await send("openai", openai.port, "deepseek-chat", { reasoningEffort: "none" });
	check(
		"选 None 时发 disabled",
		openai.requests[beforeNone].body.thinking?.type === "disabled",
		JSON.stringify(openai.requests[beforeNone].body.thinking)
	);

	// ---------- extra 里自己写了就尊重 ----------
	const beforeExtra = openai.requests.length;
	await send("openai", openai.port, "deepseek-chat", { extra: { thinking: { type: "disabled" } } });
	check(
		"extra 里的 thinking 不被覆盖",
		openai.requests[beforeExtra].body.thinking?.type === "disabled"
	);

	// ---------- 上游 400 拒收 thinking：去掉再试 ----------
	const picky = await startServer((url, body) =>
		body && "thinking" in body
			? { status: 400, body: { error: { message: "Unsupported parameter: thinking" } } }
			: { sse: sse([{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] }]) }
	);
	const retried = await send("openai", picky.port, "deepseek-chat");
	check("400 后重试了第二次", picky.requests.length === 2, String(picky.requests.length));
	check("重试时去掉了 thinking", !("thinking" in picky.requests[1].body));
	check(
		"重试成功仍然出正文",
		retried.parts.filter((part) => part instanceof LanguageModelTextPart).map((part) => part.value).join("") === "好"
	);

	// ---------- 思考 part 不带 id ----------
	const thinker = await startServer(() => ({
		sse: sse([
			{ choices: [{ delta: { reasoning_content: "想一下" } }] },
			{ choices: [{ delta: { content: "好" }, finish_reason: "stop" }] },
		]),
	}));
	const thoughtRun = await send("openai", thinker.port, "deepseek-chat");
	const thinkingParts = thoughtRun.parts.filter((part) => part instanceof LanguageModelThinkingPart);
	check("思考内容被转发", thinkingParts.map((part) => part.value).join("") === "想一下");
	check("思考 part 不带自造 id", thinkingParts.every((part) => part.id === undefined));
	check("正文也没被吞掉", thoughtRun.parts.some((part) => part instanceof LanguageModelTextPart));

	// ---------- Gemini：默认要思考摘要，但排除 1.x 与 None ----------
	const gemini = await startServer(() => ({
		sse: sse([
			{ candidates: [{ content: { parts: [{ text: "想", thought: true }] } }] },
			{ candidates: [{ content: { parts: [{ text: "好" }] } }] },
		]),
	}));

	const beforeG = gemini.requests.length;
	await send("gemini", gemini.port, "gemini-2.5-flash");
	const gBody = gemini.requests[beforeG].body;
	check(
		"gemini 2.5 默认要 includeThoughts",
		gBody.generationConfig?.thinkingConfig?.includeThoughts === true,
		JSON.stringify(gBody.generationConfig?.thinkingConfig)
	);

	const beforeG1 = gemini.requests.length;
	await send("gemini", gemini.port, "gemini-1.5-pro");
	check(
		"gemini 1.x 不发 thinkingConfig",
		!("thinkingConfig" in gemini.requests[beforeG1].body.generationConfig)
	);

	const beforeGNone = gemini.requests.length;
	await send("gemini", gemini.port, "gemini-2.5-flash", { reasoningEffort: "none" });
	check(
		"gemini 选 None 时不发 thinkingConfig",
		!("thinkingConfig" in gemini.requests[beforeGNone].body.generationConfig)
	);

	// ---------- Anthropic 原有行为没被改坏 ----------
	const anth = await startServer(() => ({
		sse: sse([
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
		]),
	}));
	const beforeA = anth.requests.length;
	// 思考预算至少 1024，输出上限得比它大才发得出去
	const anthRun = await send("anthropic", anth.port, "claude-sonnet-4", {
		reasoningEffort: "high",
		maxOutputTokens: 8192,
	});
	check(
		"anthropic 选了档位仍然发 thinking",
		anth.requests[beforeA].body.thinking?.type === "enabled",
		JSON.stringify(anth.requests[beforeA].body.thinking)
	);
	check(
		"anthropic 开思考时不发 temperature",
		!("temperature" in anth.requests[beforeA].body)
	);
	check(
		"anthropic 的思考内容被转发",
		anthRun.parts
			.filter((part) => part instanceof LanguageModelThinkingPart)
			.map((part) => part.value)
			.join("") === "想"
	);

	openai.server.close();
	picky.server.close();
	thinker.server.close();
	gemini.server.close();
	anth.server.close();

	const failed = results.filter((item) => !item.ok);
	for (const item of results) {
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  -> ${item.detail}` : ""}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
