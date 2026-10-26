/** 扩展内共用的数据结构。 */

export type CapabilitySource = "models.dev" | "heuristic" | "default";

export type ProtocolModeName = "openai" | "openai-responses" | "anthropic" | "gemini";

/** 一个可用于 Copilot 的模型。 */
export interface ModelEntry {
	id: string;
	name: string;
	contextLength: number;
	/** 模型自己声明的最大输出量（models.dev 的 limit.output）。没有就不限制，交给上游默认值。 */
	outputLength?: number;
	toolCalling: boolean;
	vision: boolean;
	reasoning: boolean;
	source: CapabilitySource;
	/** 关闭后不注入 Copilot，但保留在列表里。 */
	enabled: boolean;
	/** 这个模型走哪种协议。扫描时按模型名推断，面板里可以逐个改。 */
	apiMode: ProtocolModeName;
	/** 支持的思考档位（来自 OpenRouter），空表示未知。 */
	supportedEfforts?: string[];
	defaultEffort?: string;
	/** 上游是否强制思考。只有明确为 false 时，选择器才提供“停用”档。 */
	effortMandatory?: boolean;
	/** 档位是用户从别的模型套用过来的，刷新时不能被上游冲掉。 */
	effortManual?: boolean;
	temperature?: number;
	topP?: number;
	/** 追加到请求体的字段。 */
	extra?: Record<string, unknown>;
	/** 实测这条线路不认思考参数（400 后自动记下）；刷新模型列表会清掉。 */
	thinkingUnsupported?: boolean;
	/** 实测这条线路不认工具定义（400 后自动记下）；刷新模型列表会清掉。 */
	toolUnsupported?: boolean;
}

/** 一个中转站。 */
export interface SiteEntry {
	id: string;
	name: string;
	baseUrl: string;
	/** 停用后这个站点的模型不再注入 Copilot；不写视为启用。 */
	enabled?: boolean;
}

/** 面板与扩展宿主之间同步的状态快照。 */
export interface PanelState {
	enabled: boolean;
	baseUrl: string;
	/** 当前站点名，给面板回填用。 */
	siteName: string;
	hasApiKey: boolean;
	apiKeyHint: string;
	models: ModelEntry[];
	status: "idle" | "scanning" | "ready" | "error";
	message: string;
	lastScanAt: number | null;
	sites: SiteEntry[];
	activeSiteId: string;
	/** 当前 VS Code 是否提供思考内容的展示能力。 */
	thinkingSupported: boolean;
}

/** 面板发给扩展宿主的消息。 */
export type PanelInbound =
	| { type: "ready" }
	| { type: "connect"; baseUrl: string; apiKey: string; siteName?: string; asNew?: boolean }
	| { type: "rescan" }
	| { type: "setEnabled"; enabled: boolean }
	| { type: "clear" }
	| { type: "openSettings" }
	| { type: "selectSite"; siteId: string }
	| { type: "setSiteEnabled"; siteId: string; enabled: boolean }
	| { type: "renameSite"; siteId: string; name: string }
	| { type: "removeSite"; siteId: string }
	| { type: "toggleModel"; modelId: string; enabled: boolean }
	| { type: "setAllModels"; enabled: boolean }
	| { type: "setModelProtocol"; modelId: string; apiMode: ProtocolModeName }
	| { type: "setModelEfforts"; modelId: string; sourceModelId: string | null };

/** 扩展宿主发给面板的消息。 */
export interface PanelOutbound {
	type: "state";
	state: PanelState;
}
