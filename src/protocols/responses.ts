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

type InputItem = Record<string, unknown>;

function endpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/i.test(normalized) ? `${normalized}/responses` : `${normalized}/v1/responses`;
}

/** Responses API 的输入项：文字用 input_text，图片用 input_image，工具调用/结果单独成项。 */
function convertInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): InputItem[] {
	const input: InputItem[] = [];

	for (const message of messages) {
		const role = mapRole(message);
		const texts: string[] = [];
		const images: vscode.LanguageModelDataPart[] = [];
		const calls: Array<{ callId: string; name: string; args: string }> = [];
		const results: Array<{ callId: string; text: string }> = [];

		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				texts.push(part.value);
			} else if (isImagePart(part)) {
				images.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				calls.push({
					callId: part.callId || `call_${Math.random().toString(36).slice(2, 10)}`,
					name: part.name,
					args: safeJson(part.input),
				});
			} else if (isToolResultPart(part)) {
				results.push({ callId: part.callId, text: toolResultText(part) });
			}
		}

		const text = texts.join("").trim();

		if (role === "assistant") {
			if (text) {
				input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
			}
			for (const call of calls) {
				input.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.args });
			}
		}

		for (const result of results) {
			input.push({ type: "function_call_output", call_id: result.callId, output: result.text });
		}

		if (role === "user") {
			const content: unknown[] = [];
			if (text) {
				content.push({ type: "input_text", text });
			}
			for (const image of images) {
				content.push({ type: "input_image", image_url: imageDataUrl(image) });
			}
			if (content.length > 0) {
				input.push({ type: "message", role: "user", content });
			}
		}

		if (role === "system" && text) {
			input.push({ type: "message", role: "system", content: [{ type: "input_text", text }] });
		}
	}

	return input;
}

export class ResponsesProtocol implements Protocol {
	async send(request: ChatRequest): Promise<void> {
		const body: Record<string, unknown> = {
			model: request.modelId,
			input: convertInput(request.messages),
			stream: true,
		};
		// 不知道上限就不发，让上游用自己的默认值
		if (request.maxOutputTokens) {
			body.max_output_tokens = request.maxOutputTokens;
		}

		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.inputSchema ?? { type: "object", properties: {} },
			}));
			body.tool_choice = "auto";
		}
		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}
		if (request.topP !== undefined) {
			body.top_p = request.topP;
		}
		if (request.reasoningEffort && request.reasoningEffort !== "none") {
			body.reasoning = { effort: request.reasoningEffort };
		}
		Object.assign(body, request.extra ?? {});

		const response = await fetchWithRetry({
			url: endpoint(request.baseUrl),
			init: {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
				body: JSON.stringify(body),
			},
			signal: request.signal,
		});

		if (!response.ok) {
			throw errorFromResponse(response.status, response.statusText, await response.text().catch(() => ""));
		}
		if (!response.body) {
			throw new Error("上游没有返回响应体");
		}

		// item_id -> 工具调用缓冲
		const calls = new Map<string, { callId: string; name: string; args: string }>();

		const emitCall = (itemId: string): void => {
			const call = calls.get(itemId);
			if (!call) {
				return;
			}
			const input = parseJsonObject(call.args);
			if (!input) {
				return;
			}
			request.reporter.toolCall(call.callId || itemId, call.name, input);
			calls.delete(itemId);
		};

		await readLines(response.body, (line) => {
			const event = parseSseData(line);
			if (!event) {
				return;
			}
			const type = event.type;

			if (type === "response.output_text.delta" && typeof event.delta === "string") {
				request.reporter.text(event.delta);
				return;
			}

			if (typeof type === "string" && type.startsWith("response.reasoning") && typeof event.delta === "string") {
				request.reporter.thinking(event.delta);
				return;
			}

			if (type === "response.output_item.added") {
				const item = event.item as Record<string, unknown> | undefined;
				if (item?.type === "function_call") {
					calls.set(String(item.id ?? ""), {
						callId: String(item.call_id ?? ""),
						name: String(item.name ?? ""),
						args: "",
					});
				}
				return;
			}

			if (type === "response.function_call_arguments.delta") {
				const itemId = String(event.item_id ?? "");
				const call = calls.get(itemId);
				if (call && typeof event.delta === "string") {
					call.args += event.delta;
				}
				return;
			}

			if (type === "response.output_item.done") {
				const item = event.item as Record<string, unknown> | undefined;
				if (item?.type === "function_call") {
					const itemId = String(item.id ?? "");
					const call = calls.get(itemId);
					if (call && typeof item.arguments === "string") {
						call.args = item.arguments;
						if (!call.name && typeof item.name === "string") {
							call.name = item.name;
						}
					}
					emitCall(itemId);
				}
			}
		});

		for (const itemId of Array.from(calls.keys())) {
			emitCall(itemId);
		}
	}
}
