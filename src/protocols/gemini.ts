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
import { thinkingFlavor } from "./thinking";

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

function endpoint(baseUrl: string, modelId: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	const withVersion = /\/v\d+(alpha|beta)?\d*$/i.test(normalized) ? normalized : `${normalized}/v1beta`;
	return `${withVersion}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

/** 预先记录 callId → 函数名，Gemini 的工具结果必须带函数名。 */
function collectToolNames(messages: readonly vscode.LanguageModelChatRequestMessage[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const message of messages) {
		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				names.set(part.callId, part.name);
			}
		}
	}
	return names;
}

function convertContents(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	toolNames: Map<string, string>
): { contents: GeminiContent[]; systemText: string } {
	const contents: GeminiContent[] = [];
	const systemParts: string[] = [];

	for (const message of messages) {
		const role = mapRole(message);
		const parts: GeminiPart[] = [];

		for (const part of message.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				if (part.value.trim()) {
					parts.push({ text: part.value });
				}
			} else if (isImagePart(part)) {
				parts.push({
					inlineData: {
						mimeType: part.mimeType,
						data: Buffer.from(part.data).toString("base64"),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(safeJson(part.input)) as Record<string, unknown>;
				} catch {
					args = {};
				}
				parts.push({ functionCall: { name: part.name, args } });
			} else if (isToolResultPart(part)) {
				parts.push({
					functionResponse: {
						name: toolNames.get(part.callId) ?? part.callId,
						response: { result: toolResultText(part) },
					},
				});
			}
		}

		if (role === "system") {
			const text = parts
				.map((part) => (typeof part.text === "string" ? part.text : ""))
				.join("\n")
				.trim();
			if (text) {
				systemParts.push(text);
			}
			continue;
		}

		if (parts.length > 0) {
			// 工具结果按 Gemini 的要求，也必须放在 user 角色里
			const resolvedRole: "user" | "model" = role === "assistant" ? "model" : "user";
			const last = contents[contents.length - 1];
			if (last && last.role === resolvedRole) {
				last.parts.push(...parts);
			} else {
				contents.push({ role: resolvedRole, parts });
			}
		}
	}

	return { contents, systemText: systemParts.join("\n\n") };
}

export class GeminiProtocol implements Protocol {
	async send(request: ChatRequest): Promise<void> {
		const toolNames = collectToolNames(request.messages);
		const { contents, systemText } = convertContents(request.messages, toolNames);

		const generationConfig: Record<string, unknown> = {
			maxOutputTokens: request.maxOutputTokens,
		};
		if (request.temperature !== undefined) {
			generationConfig.temperature = request.temperature;
		}
		if (request.topP !== undefined) {
			generationConfig.topP = request.topP;
		}
		// Gemini 只有显式要 includeThoughts 才会回思考摘要；认得出是 Gemini 就默认要，
		// 1.x 还不支持 thinkingConfig，发了会被打回 400，排除掉
		const wantsThoughts = thinkingFlavor(request.modelId) === "gemini" && !/gemini-1/i.test(request.modelId);
		if (wantsThoughts && request.reasoningEffort !== "none") {
			generationConfig.thinkingConfig = { includeThoughts: true };
		}

		const body: Record<string, unknown> = { contents, generationConfig };
		if (systemText) {
			body.systemInstruction = { parts: [{ text: systemText }] };
		}
		if (request.tools && request.tools.length > 0) {
			body.tools = [
				{
					functionDeclarations: request.tools.map((tool) => ({
						name: tool.name,
						description: tool.description ?? "",
						parameters: tool.inputSchema ?? { type: "object", properties: {} },
					})),
				},
			];
		}
		Object.assign(body, request.extra ?? {});

		const response = await fetchWithRetry({
			url: endpoint(request.baseUrl, request.modelId),
			init: {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-goog-api-key": request.apiKey,
					Accept: "text/event-stream",
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

		await readLines(response.body, (line) => {
			const event = parseSseData(line);
			if (!event) {
				return;
			}
			const candidates = event.candidates as Array<Record<string, unknown>> | undefined;
			const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
			const parts = content?.parts as GeminiPart[] | undefined;
			if (!Array.isArray(parts)) {
				return;
			}

			for (const part of parts) {
				if (typeof part.text === "string" && part.text) {
					// Gemini 用 thought 标记思考片段
					if (part.thought === true) {
						request.reporter.thinking(part.text);
					} else {
						request.reporter.text(part.text);
					}
				}
				const call = part.functionCall as Record<string, unknown> | undefined;
				if (call && typeof call.name === "string") {
					const args = call.args;
					const input =
						typeof args === "string" ? parseJsonObject(args) : (args as Record<string, unknown> | undefined);
					request.reporter.toolCall(`call_${Math.random().toString(36).slice(2, 10)}`, call.name, input ?? {});
				}
			}
		});
	}
}
