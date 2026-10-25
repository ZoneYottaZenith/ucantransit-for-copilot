import * as vscode from "vscode";
import { errorFromResponse, fetchWithRetry, parseSseData, readLines } from "../http";
import {
	imageDataUrl,
	isImagePart,
	isToolResultPart,
	mapRole,
	parseJsonObject,
	safeJson,
	toolResultText,
	type ChatRequest,
	type Protocol,
} from "./types";
import { thinkingFlavor } from "./thinking";

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | unknown[];
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];

	for (const message of messages) {
		const role = mapRole(message);
		const texts: string[] = [];
		const images: vscode.LanguageModelDataPart[] = [];
		const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				texts.push(part.value);
			} else if (isImagePart(part)) {
				images.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId || `call_${Math.random().toString(36).slice(2, 10)}`,
					type: "function",
					function: { name: part.name, arguments: safeJson(part.input) },
				});
			} else if (isToolResultPart(part)) {
				toolResults.push({ callId: part.callId, content: toolResultText(part) });
			}
		}

		const text = texts.join("").trim();

		if (role === "assistant" && (text || toolCalls.length > 0)) {
			const assistant: OpenAIMessage = { role: "assistant" };
			if (text) {
				assistant.content = text;
			}
			if (toolCalls.length > 0) {
				assistant.tool_calls = toolCalls;
			}
			out.push(assistant);
		}

		for (const result of toolResults) {
			out.push({ role: "tool", tool_call_id: result.callId, content: result.content });
		}

		if (role === "user") {
			if (images.length > 0) {
				const content: unknown[] = [];
				if (text) {
					content.push({ type: "text", text });
				}
				for (const image of images) {
					content.push({ type: "image_url", image_url: { url: imageDataUrl(image) } });
				}
				out.push({ role: "user", content });
			} else if (text) {
				out.push({ role: "user", content: text });
			}
		}

		if (role === "system" && text) {
			out.push({ role: "system", content: text });
		}
	}

	return out;
}

export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	toolMode: vscode.LanguageModelChatToolMode | undefined
): { tools?: unknown[]; tool_choice?: unknown } {
	if (!tools || tools.length === 0) {
		return {};
	}
	const defs = tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description ?? "",
			parameters: tool.inputSchema ?? { type: "object", properties: {} },
		},
	}));
	const choice =
		toolMode === vscode.LanguageModelChatToolMode.Required
			? { type: "function", function: { name: tools[0].name } }
			: "auto";
	return { tools: defs, tool_choice: choice };
}

function endpoint(baseUrl: string, path: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/i.test(normalized) ? `${normalized}${path}` : `${normalized}/v1${path}`;
}

/**
 * 给认得出的厂商补上“开思考”的字段。
 *
 * 不带这个字段时，不少线路默认按非思考模式走，上游一个字都不吐，界面自然看不到思考。
 * 用户显式选了 none 才发关闭指令；认不出厂商就一个字段都不加，不乱猜。
 */
function applyThinking(body: Record<string, unknown>, request: ChatRequest): void {
	const flavor = thinkingFlavor(request.modelId);
	if (flavor === "none") {
		return;
	}
	const on = request.reasoningEffort !== "none";
	if (flavor === "qwen") {
		if (!("enable_thinking" in body)) {
			body.enable_thinking = on;
		}
		return;
	}
	if (!("thinking" in body)) {
		body.thinking = { type: on ? "enabled" : "disabled" };
	}
}

export class OpenAIChatProtocol implements Protocol {
	async send(request: ChatRequest): Promise<void> {
		const { tools, tool_choice } = convertTools(request.tools, request.toolMode);

		const body: Record<string, unknown> = {
			model: request.modelId,
			messages: convertMessages(request.messages),
			stream: true,
			max_tokens: request.maxOutputTokens,
		};
		if (tools) {
			body.tools = tools;
			body.tool_choice = tool_choice;
		}
		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}
		if (request.topP !== undefined) {
			body.top_p = request.topP;
		}
		if (request.reasoningEffort && request.reasoningEffort !== "none") {
			body.reasoning_effort = request.reasoningEffort;
		}
		Object.assign(body, request.extra ?? {});
		applyThinking(body, request);

		const post = async (payload: Record<string, unknown>): Promise<Response> =>
			fetchWithRetry({
				url: endpoint(request.baseUrl, "/chat/completions"),
				init: {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
					body: JSON.stringify(payload),
				},
				signal: request.signal,
				timeoutMs: 120_000,
			});

		let response = await post(body);

		// 少数新模型拒收 max_tokens，或拒收 reasoning_effort：去掉后重来一次
		if (response.status === 400) {
			const detail = await response.clone().text().catch(() => "");
			const retryBody = { ...body };
			let changed = false;
			if (/max_tokens|max_completion_tokens/i.test(detail) && "max_tokens" in retryBody) {
				delete retryBody.max_tokens;
				changed = true;
			}
			if (/reasoning_effort|reasoning/i.test(detail) && "reasoning_effort" in retryBody) {
				delete retryBody.reasoning_effort;
				changed = true;
			}
			// 有些线路直接拒收 thinking / enable_thinking，去掉再走一次
			if (/thinking/i.test(detail) && ("thinking" in retryBody || "enable_thinking" in retryBody)) {
				delete retryBody.thinking;
				delete retryBody.enable_thinking;
				changed = true;
			}
			if (changed) {
				response = await post(retryBody);
			}
		}

		if (!response.ok) {
			throw errorFromResponse(response.status, response.statusText, await response.text().catch(() => ""));
		}
		if (!response.body) {
			throw new Error("上游没有返回响应体");
		}

		const pending = new Map<number, { id?: string; name?: string; args: string }>();
		const done = new Set<number>();

		const flush = (index: number): void => {
			const call = pending.get(index);
			if (!call || done.has(index) || !call.name) {
				return;
			}
			const input = parseJsonObject(call.args);
			if (!input) {
				return;
			}
			request.reporter.toolCall(call.id ?? `call_${Math.random().toString(36).slice(2, 10)}`, call.name, input);
			done.add(index);
			pending.delete(index);
		};

		const flushAll = (): void => {
			for (const index of Array.from(pending.keys())) {
				flush(index);
			}
		};

		await readLines(response.body, (line) => {
			const chunk = parseSseData(line);
			if (!chunk) {
				return;
			}
			const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
			if (!choice) {
				return;
			}
			const delta = choice.delta as Record<string, unknown> | undefined;

			const reasoning = delta?.reasoning_content ?? delta?.reasoning;
			if (typeof reasoning === "string" && reasoning) {
				request.reporter.thinking(reasoning);
			}
			if (typeof delta?.content === "string" && delta.content) {
				request.reporter.text(delta.content);
			}

			const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(calls)) {
				for (const call of calls) {
					const index = typeof call.index === "number" ? call.index : 0;
					const entry = pending.get(index) ?? { args: "" };
					if (typeof call.id === "string") {
						entry.id = call.id;
					}
					const fn = call.function as Record<string, unknown> | undefined;
					if (typeof fn?.name === "string") {
						entry.name = fn.name;
					}
					if (typeof fn?.arguments === "string") {
						entry.args += fn.arguments;
					}
					pending.set(index, entry);
					flush(index);
				}
			}

			const finish = choice.finish_reason;
			if (finish === "tool_calls" || finish === "stop") {
				flushAll();
			}
		});

		flushAll();
	}
}
