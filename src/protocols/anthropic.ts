import * as vscode from "vscode";
import { errorFromResponse, fetchWithRetry, parseSseData, readLines } from "../http";
import {
	isImagePart,
	isToolResultPart,
	mapRole,
	parseJsonObject,
	safeJson,
	toolResultText,
	type ChatRequest,
	type Protocol,
} from "./types";

interface AnthropicBlock extends Record<string, unknown> {}

function endpoint(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	return /\/v\d+$/i.test(normalized) ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function imageBlock(part: vscode.LanguageModelDataPart): AnthropicBlock {
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: part.mimeType,
			data: Buffer.from(part.data).toString("base64"),
		},
	};
}

export class AnthropicProtocol implements Protocol {
	async send(request: ChatRequest): Promise<void> {
		const systemTexts: string[] = [];
		const messages: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];

		for (const message of request.messages) {
			const role = mapRole(message);
			const blocks: AnthropicBlock[] = [];
			const toolResults: AnthropicBlock[] = [];

			for (const part of message.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					if (part.value.trim()) {
						blocks.push({ type: "text", text: part.value });
					}
				} else if (isImagePart(part)) {
					blocks.push(imageBlock(part));
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					let input: Record<string, unknown> = {};
					try {
						input = JSON.parse(safeJson(part.input)) as Record<string, unknown>;
					} catch {
						input = {};
					}
					blocks.push({
						type: "tool_use",
						id: part.callId || `call_${Math.random().toString(36).slice(2, 10)}`,
						name: part.name,
						input,
					});
				} else if (isToolResultPart(part)) {
					toolResults.push({
						type: "tool_result",
						tool_use_id: part.callId,
						content: toolResultText(part),
					});
				}
			}

			if (role === "system") {
				const text = blocks
					.filter((block) => block.type === "text")
					.map((block) => String(block.text ?? ""))
					.join("\n")
					.trim();
				if (text) {
					systemTexts.push(text);
				}
				continue;
			}

			// 工具结果必须作为 user 消息回传
			if (toolResults.length > 0) {
				messages.push({ role: "user", content: toolResults });
			}
			if (blocks.length > 0) {
				messages.push({ role: role === "assistant" ? "assistant" : "user", content: blocks });
			}
		}

		const body: Record<string, unknown> = {
			model: request.modelId,
			max_tokens: request.maxOutputTokens,
			messages,
			stream: true,
		};
		if (systemTexts.length > 0) {
			body.system = systemTexts.join("\n\n");
		}
		if (request.tools && request.tools.length > 0) {
			body.tools = request.tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				input_schema: tool.inputSchema ?? { type: "object", properties: {} },
			}));
		}
		// 开了 thinking 时 Anthropic 要求 temperature 固定，这里干脆不发
		const wantsThinking = Boolean(request.reasoningEffort && request.reasoningEffort !== "none");
		if (wantsThinking) {
			const budget = Math.min(16_000, Math.max(1024, Math.floor(request.maxOutputTokens / 2)));
			if (budget < request.maxOutputTokens) {
				body.thinking = { type: "enabled", budget_tokens: budget };
			}
		} else if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}
		if (request.topP !== undefined && !wantsThinking) {
			body.top_p = request.topP;
		}
		Object.assign(body, request.extra ?? {});

		const response = await fetchWithRetry({
			url: endpoint(request.baseUrl),
			init: {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": request.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(body),
			},
			signal: request.signal,
			timeoutMs: 120_000,
		});

		if (!response.ok) {
			throw errorFromResponse(response.status, response.statusText, await response.text().catch(() => ""));
		}
		if (!response.body) {
			throw new Error("上游没有返回响应体");
		}

		const blocks = new Map<number, { id: string; name: string; args: string }>();

		await readLines(response.body, (line) => {
			const event = parseSseData(line);
			if (!event) {
				return;
			}
			const type = event.type;

			if (type === "error") {
				const error = event.error as Record<string, unknown> | undefined;
				throw new Error(`上游错误：${String(error?.message ?? "未知错误")}`);
			}

			if (type === "content_block_start") {
				const block = event.content_block as Record<string, unknown> | undefined;
				const index = Number(event.index ?? 0);
				if (block?.type === "tool_use") {
					blocks.set(index, {
						id: String(block.id ?? ""),
						name: String(block.name ?? ""),
						args: "",
					});
				}
				return;
			}

			if (type === "content_block_delta") {
				const delta = event.delta as Record<string, unknown> | undefined;
				const index = Number(event.index ?? 0);
				if (delta?.type === "text_delta" && typeof delta.text === "string") {
					request.reporter.text(delta.text);
				} else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
					request.reporter.thinking(delta.thinking);
				} else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
					const block = blocks.get(index);
					if (block) {
						block.args += delta.partial_json;
					}
				}
				return;
			}

			if (type === "content_block_stop") {
				const index = Number(event.index ?? 0);
				const block = blocks.get(index);
				if (!block) {
					return;
				}
				const input = parseJsonObject(block.args);
				if (input) {
					request.reporter.toolCall(block.id || `call_${index}`, block.name, input);
				}
				blocks.delete(index);
			}
		});
	}
}
