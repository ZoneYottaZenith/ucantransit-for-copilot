/**
 * 协议层自检：五种协议 + 思考内容 + 工具调用 + max_tokens 兼容重试。
 * 全部走本地随机端口，不联网、不改系统。
 *
 * 运行：node 测试脚本/协议自检.js
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
const { sendChat, guessProtocol } = require(path.join(outDir, "protocols", "index.js"));
const { Reporter } = require(path.join(outDir, "report.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

function sse(events) {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function ndjson(rows) {
	return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
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
				} else if (reply.ndjson !== undefined) {
					res.writeHead(200, { "Content-Type": "application/x-ndjson" });
					res.end(reply.ndjson);
				} else {
					res.writeHead(reply.status ?? 500, { "Content-Type": "application/json" });
					res.end(JSON.stringify(reply.body ?? {}));
				}
			});
		});
		server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
	});
}

async function run(server, mode, port, extra = {}) {
	const parts = [];
	const progress = {
		report(part) {
			parts.push(part);
		},
	};
	await sendChat(mode, {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "test-key",
		modelId: "test-model",
		messages: [{ role: 1, content: [new LanguageModelTextPart("你好")] }],
		maxOutputTokens: 512,
		signal: new AbortController().signal,
		reporter: new Reporter(progress),
		...extra,
	});
	return parts;
}

function collect(parts) {
	return {
		text: parts
			.filter((part) => part instanceof LanguageModelTextPart)
			.map((part) => part.value)
			.join(""),
		thinking: parts
			.filter((part) => part instanceof LanguageModelThinkingPart)
			.map((part) => part.value)
			.join(""),
		calls: parts
			.filter((part) => part instanceof LanguageModelToolCallPart)
			.map((part) => ({ name: part.name, input: part.input })),
	};
}

async function main() {
	// ---------- openai ----------
	const openai = await startServer(() => ({
		sse: sse([
			{ choices: [{ delta: { reasoning_content: "想一下" } }] },
			{ choices: [{ delta: { content: "你好" } }] },
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } },
							],
						},
					},
				],
			},
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]),
	}));

	// ---------- responses ----------
	const responses = await startServer(() => ({
		sse: sse([
			{ type: "response.output_text.delta", delta: "你好" },
			{
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"path":"a.txt"}' },
			{
				type: "response.output_item.done",
				item: { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
			},
		]),
	}));

	// ---------- anthropic ----------
	const anthropic = await startServer(() => ({
		sse: sse([
			{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一下" } },
			{ type: "content_block_start", index: 1, content_block: { type: "text" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } },
			{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
			{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } },
			{ type: "content_block_stop", index: 2 },
		]),
	}));

	// ---------- gemini ----------
	const gemini = await startServer(() => ({
		sse: sse([
			{ candidates: [{ content: { parts: [{ text: "你好" }] } }] },
			{ candidates: [{ content: { parts: [{ text: "想一下", thought: true }] } }] },
			{ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }] } }] },
		]),
	}));

	// ---------- 重试 ----------
	const retryServer = await startServer((_url, _body, attempt) =>
		attempt === 1
			? { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens'" } } }
			: { sse: sse([{ choices: [{ delta: { content: "重试成功" } }] }]) }
	);

	try {
		const openaiParts = collect(await run(openai, "openai", openai.port));
		check("openai：文本", openaiParts.text === "你好", openaiParts.text);
		check("openai：思考内容", openaiParts.thinking.includes("想一下"), openaiParts.thinking);
		check("openai：工具调用", openaiParts.calls[0]?.name === "read_file" && openaiParts.calls[0]?.input.path === "a.txt", JSON.stringify(openaiParts.calls));

		const responsesParts = collect(await run(responses, "openai-responses", responses.port));
		check("responses：文本", responsesParts.text === "你好", responsesParts.text);
		check("responses：工具调用", responsesParts.calls[0]?.input.path === "a.txt", JSON.stringify(responsesParts.calls));
		check(
			"responses：请求走 /responses",
			responses.requests[0].url.includes("/responses"),
			responses.requests[0].url
		);

		const anthropicParts = collect(await run(anthropic, "anthropic", anthropic.port));
		check("anthropic：文本", anthropicParts.text === "你好", anthropicParts.text);
		check("anthropic：思考内容", anthropicParts.thinking.includes("想一下"), anthropicParts.thinking);
		check("anthropic：工具调用", anthropicParts.calls[0]?.input.path === "a.txt", JSON.stringify(anthropicParts.calls));
		check(
			"anthropic：使用 x-api-key 头",
			anthropic.requests[0].url.includes("/messages"),
			anthropic.requests[0].url
		);

		const geminiParts = collect(await run(gemini, "gemini", gemini.port));
		check("gemini：文本", geminiParts.text === "你好", geminiParts.text);
		check("gemini：思考内容", geminiParts.thinking.includes("想一下"), geminiParts.thinking);
		check("gemini：工具调用", geminiParts.calls[0]?.input.path === "a.txt", JSON.stringify(geminiParts.calls));
		check(
			"gemini：请求带 alt=sse",
			gemini.requests[0].url.includes("streamGenerateContent") && gemini.requests[0].url.includes("alt=sse"),
			gemini.requests[0].url
		);

		const retryParts = collect(await run(retryServer, "openai", retryServer.port));
		check("openai：max_tokens 被拒后自动重试", retryParts.text === "重试成功", retryParts.text);
		check(
			"openai：重试时去掉 max_tokens",
			retryServer.requests.length === 2 && retryServer.requests[1].body.max_tokens === undefined,
			JSON.stringify(retryServer.requests[1]?.body)
		);

		// 思考强度透传
		const effortServer = await startServer(() => ({ sse: sse([{ choices: [{ delta: { content: "ok" } }] }]) }));
		await run(effortServer, "openai", effortServer.port, { reasoningEffort: "high", temperature: 0.2 });
		check(
			"openai：思考强度与温度被透传",
			effortServer.requests[0].body.reasoning_effort === "high" && effortServer.requests[0].body.temperature === 0.2,
			JSON.stringify(effortServer.requests[0].body)
		);
		// 按模型名推断协议：GPT → Responses，Claude → Messages，Gemini → Gemini 原生，其余 → Chat Completions
		const guesses = [
			["gpt-5.5", "openai-responses"],
			["openai/gpt-4o-mini", "openai-responses"],
			["o3-mini", "openai-responses"],
			["claude-sonnet-4", "anthropic"],
			["anthropic/claude-3.5-sonnet", "anthropic"],
			["gemini-2.5-pro", "gemini"],
			["google/gemini-2.0-flash", "gemini"],
			["deepseek-v3", "openai"],
			["qwen-max", "openai"],
			["gpt-3.5-turbo", "openai"],
		];
		for (const [modelId, expected] of guesses) {
			const actual = guessProtocol(modelId);
			check(`协议推断：${modelId}`, actual === expected, actual);
		}

		effortServer.server.close();
	} finally {
		for (const item of [openai, responses, anthropic, gemini, retryServer]) {
			item.server.close();
		}
	}

	const failed = results.filter((item) => !item.ok);
	for (const item of results) {
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  -> ${item.detail}` : ""}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
	console.error("自检失败：", error);
	process.exitCode = 1;
});
