import { AnthropicProtocol } from "./anthropic";
import { GeminiProtocol } from "./gemini";
import { OpenAIChatProtocol } from "./openai";
import { ResponsesProtocol } from "./responses";
import type { ChatRequest, Protocol, ProtocolMode } from "./types";

export type {
	ChatRequest,
	Protocol,
	ProtocolMode,
	ProtocolMode as ProtocolModeName,
} from "./types";
export { guessProtocol } from "./types";

export const PROTOCOL_LABELS: Record<ProtocolMode, string> = {
	openai: "OpenAI Chat Completions",
	"openai-responses": "OpenAI Responses",
	anthropic: "Anthropic Messages",
	gemini: "Gemini",
};

const instances: Record<ProtocolMode, Protocol> = {
	openai: new OpenAIChatProtocol(),
	"openai-responses": new ResponsesProtocol(),
	anthropic: new AnthropicProtocol(),
	gemini: new GeminiProtocol(),
};

export async function sendChat(mode: ProtocolMode, request: ChatRequest): Promise<void> {
	const protocol = instances[mode] ?? instances.openai;
	await protocol.send(request);
}
