import * as vscode from "vscode";
import type { Reporter, TokenUsage } from "../report";

export type ProtocolMode = "openai" | "openai-responses" | "anthropic" | "gemini";

/** 各协议实现共用的一次请求参数。 */
export interface ChatRequest {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	tools?: readonly vscode.LanguageModelChatTool[];
	toolMode?: vscode.LanguageModelChatToolMode;
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	reasoningEffort?: string;
	/** 每模型额外的请求体字段。 */
	extra?: Record<string, unknown>;
	signal: AbortSignal;
	reporter: Reporter;
	/** 已知这条线路不认思考参数，直接跳过相关字段。 */
	thinkingUnsupported?: boolean;
	/** 已知这条线路不认工具定义，直接不传 tools。 */
	toolUnsupported?: boolean;
	/** 上游拒了某个字段时回调，宿主据此下次不再发。 */
	onDowngrade?: (field: "thinking" | "tools") => void;
	/** 拿到真实用量时回调，宿主用它校准 token 估算。 */
	onUsage?: (usage: TokenUsage) => void;
}

export interface Protocol {
	send(request: ChatRequest): Promise<void>;
}

/** 消息里的图片转 data URL。 */
export function imageDataUrl(part: vscode.LanguageModelDataPart): string {
	return `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`;
}

/** 递归找消息里的图片。 */
export function isImagePart(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/");
}

export function isToolResultPart(value: unknown): value is { callId: string; content?: readonly unknown[] } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return typeof record.callId === "string" && "content" in record;
}

export function toolResultText(part: { content?: readonly unknown[] }): string {
	let text = "";
	for (const item of part.content ?? []) {
		if (item instanceof vscode.LanguageModelTextPart) {
			text += item.value;
		} else if (typeof item === "string") {
			text += item;
		} else {
			try {
				text += JSON.stringify(item);
			} catch {
				// 无法序列化的内容直接跳过
			}
		}
	}
	return text;
}

export function mapRole(message: vscode.LanguageModelChatRequestMessage): "system" | "user" | "assistant" {
	const role = message.role as unknown as number;
	if (role === (vscode.LanguageModelChatMessageRole.User as unknown as number)) {
		return "user";
	}
	if (role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number)) {
		return "assistant";
	}
	return "system";
}

export function safeJson(value: unknown, fallback = "{}"): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return fallback;
	}
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) {
		return {};
	}
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 按模型名猜它原生的协议。
 *
 * 只管猜个起点：中转站不一定以原生形态暴露模型，所以发请求失败时会退回
 * Chat Completions 重试，成功了就把协议记下来。
 */
export function guessProtocol(modelId: string): ProtocolMode {
	const id = modelId.toLowerCase();
	if (/(^|[/:_-])(claude|anthropic)/.test(id)) {
		return "anthropic";
	}
	if (/(^|[/:_-])(gemini|gemma)/.test(id)) {
		return "gemini";
	}
	// GPT 新代和 o 系列、Codex 走 Responses；gpt-3.x 这类老模型仍然只有 Chat Completions
	if (/gpt-3[.-]/.test(id)) {
		return "openai";
	}
	if (/(^|[/:_-])(gpt-|o[1-9]|chatgpt|codex)/.test(id)) {
		return "openai-responses";
	}
	return "openai";
}
