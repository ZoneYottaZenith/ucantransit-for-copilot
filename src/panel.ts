import * as vscode from "vscode";
import {
	getActiveSite,
	getActiveSiteId,
	getApiKey,
	getModels,
	getSites,
	isEnabled,
	maskKey,
	removeSite,
	saveApiKey,
	saveModels,
	saveSite,
	setActiveSiteId,
	setEnabled,
	setModelProtocol,
	setSiteEnabled,
} from "./config";
import { mergeModels, scanModels, withEffortsFrom } from "./modelCatalog";
import { ModelsDevCatalog } from "./modelsDev";
import { ReasoningCatalog } from "./reasoningCatalog";
import type { ModelEntry, PanelInbound, PanelState, ProtocolModeName, SiteEntry } from "./types";
import type { TransitModelProvider } from "./provider";

const EMPTY_REASONING = ReasoningCatalog.empty();

/** 侧边栏面板：唯一需要用户操作的入口。 */
export class PanelViewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = "ucantransit.panel";

	private view: vscode.WebviewView | undefined;
	private status: PanelState["status"] = "idle";
	private message = "";
	private lastScanAt: number | null = null;
	private scanning = false;
	private reasoning: ReasoningCatalog = EMPTY_REASONING;
	/** 消息排队执行：读-改-写配置时不能交错，否则后一条会把前一条盖掉。 */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly secrets: vscode.SecretStorage,
		private readonly provider: TransitModelProvider
	) {}

	/** 档位数据是异步加载的，就绪后通知面板重画。 */
	setReasoningCatalog(catalog: ReasoningCatalog): void {
		this.reasoning = catalog;
		void this.pushState();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
		};
		void this.render(view.webview).then((html) => {
			view.webview.html = html;
		});
		view.webview.onDidReceiveMessage((message: PanelInbound) => {
			this.queue = this.queue.then(() => this.handle(message)).catch(() => undefined);
		});
		void this.pushState();
	}

	async pushState(): Promise<void> {
		if (!this.view) {
			return;
		}
		const site = getActiveSite();
		const siteId = site?.id ?? "";
		const apiKey = siteId ? await getApiKey(this.secrets, siteId) : undefined;
		const state: PanelState = {
			enabled: isEnabled(),
			baseUrl: site?.baseUrl ?? "",
			siteName: site?.name ?? "",
			hasApiKey: Boolean(apiKey),
			apiKeyHint: maskKey(apiKey),
			models: siteId ? getModels(siteId) : [],
			status: this.status,
			message: this.message,
			lastScanAt: this.lastScanAt,
			sites: getSites(),
			activeSiteId: siteId,
			thinkingSupported: Boolean(
				(vscode as unknown as { LanguageModelThinkingPart?: unknown }).LanguageModelThinkingPart
			),
		};
		await this.view.webview.postMessage({ type: "state", state });
	}

	private async handle(message: PanelInbound): Promise<void> {
		switch (message.type) {
			case "ready":
				await this.pushState();
				break;
			case "connect":
				await this.connect(message.baseUrl, message.apiKey, message.siteName);
				break;
			case "rescan":
				await this.rescan();
				break;
			case "setEnabled":
				await setEnabled(message.enabled);
				this.provider.refresh();
				this.message = message.enabled
					? "已开启注入，模型会出现在 Copilot 的模型选择器里。"
					: "已关闭注入，Copilot 恢复原有模型列表。";
				await this.pushState();
				break;
			case "selectSite":
				await setActiveSiteId(message.siteId);
				this.status = getModels(message.siteId).length > 0 ? "ready" : "idle";
				this.message = "";
				this.lastScanAt = null;
				this.provider.refresh();
				await this.pushState();
				break;
			case "setSiteEnabled":
				await setSiteEnabled(message.siteId, message.enabled);
				this.provider.refresh();
				this.message = message.enabled
					? "站点已启用，它的模型重新出现在 Copilot 里。"
					: "站点已停用，它的模型已从 Copilot 里撤下。";
				await this.pushState();
				break;
			case "removeSite":
				await this.confirmRemoveSite(message.siteId);
				break;
			case "renameSite":
				await this.renameSite(message.siteId, message.name);
				break;
			case "toggleModel":
				await this.toggleModel(message.modelId, message.enabled);
				break;
			case "setAllModels":
				await this.setAllModels(message.enabled);
				break;
			case "setModelProtocol":
				await this.changeModelProtocol(message.modelId, message.apiMode);
				break;
			case "setModelEfforts":
				await this.changeModelEfforts(message.modelId, message.sourceModelId);
				break;
			case "clear":
				await this.clear();
				break;
			case "openSettings":
				await vscode.commands.executeCommand("workbench.action.openSettings", "ucantransit");
				break;
			default:
				break;
		}
	}

	private async connect(
		rawBaseUrl: string,
		rawApiKey: string,
		rawSiteName: string | undefined
	): Promise<void> {
		if (this.scanning) {
			return;
		}
		const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
		if (!/^https?:\/\//i.test(baseUrl)) {
			this.status = "error";
			this.message = "地址需要以 http:// 或 https:// 开头。";
			await this.pushState();
			return;
		}

		const current = getActiveSite();
		// 同一个地址视为“更新现有站点”，否则新建
		const siteId =
			current && current.baseUrl.replace(/\/+$/, "") === baseUrl
				? current.id
				: `site-${Date.now().toString(36)}`;

		const apiKey = rawApiKey.trim() || (await getApiKey(this.secrets, siteId)) || "";
		if (!apiKey) {
			this.status = "error";
			this.message = "还没有填写 API Key。";
			await this.pushState();
			return;
		}

		await this.runScan(
			{
				id: siteId,
				name: rawSiteName?.trim() || current?.name || hostOf(baseUrl),
				baseUrl,
			},
			apiKey
		);
	}

	private async rescan(): Promise<void> {
		if (this.scanning) {
			return;
		}
		const site = getActiveSite();
		if (!site) {
			this.status = "error";
			this.message = "请先填写地址和 API Key，再扫描。";
			await this.pushState();
			return;
		}
		const apiKey = await getApiKey(this.secrets, site.id);
		if (!apiKey) {
			this.status = "error";
			this.message = "当前站点没有保存 API Key。";
			await this.pushState();
			return;
		}
		await this.runScan(site, apiKey);
	}

	private async runScan(site: SiteEntry, apiKey: string): Promise<void> {
		this.scanning = true;
		this.status = "scanning";
		this.message = "正在连接中转站并读取模型列表…";
		await this.pushState();

		try {
			const catalog = await ModelsDevCatalog.load(this.extensionUri);
			const result = await scanModels(site.baseUrl, apiKey, catalog, { reasoning: this.reasoning });

			// 保留用户设置：启停、协议、单独调的参数都不能被一次刷新冲掉
			const previous = getModels(site.id);
			const merged = mergeModels(previous, result.models);
			const previousIds = new Set(previous.map((model) => model.id));
			const freshIds = new Set(result.models.map((model) => model.id));
			const added = result.models.filter((model) => !previousIds.has(model.id)).length;
			const removed = previous.filter((model) => !freshIds.has(model.id)).length;

			await saveSite(site);
			await saveApiKey(this.secrets, site.id, apiKey);
			await saveModels(site.id, merged);

			this.status = "ready";
			this.lastScanAt = Date.now();

			const changes: string[] = [];
			if (added > 0) {
				changes.push(`新增 ${added} 个`);
			}
			if (removed > 0) {
				changes.push(`下架 ${removed} 个`);
			}
			const summary = changes.length > 0 ? changes.join("、") : "没有变化";
			const kept = previous.length > 0 && added < merged.length ? "，你之前的设置都保留了" : "";
			this.message = `已接入 ${merged.length} 个模型（${summary}）${kept}。${
				result.warning ? ` ${result.warning}` : ""
			}`.trim();
			this.provider.refresh();
		} catch (error) {
			this.status = "error";
			this.message = error instanceof Error ? error.message : String(error);
		} finally {
			this.scanning = false;
			await this.pushState();
		}
	}

	private async toggleModel(modelId: string, enabled: boolean): Promise<void> {
		const site = getActiveSite();
		if (!site) {
			return;
		}
		const models = getModels(site.id).map((model) =>
			model.id === modelId ? { ...model, enabled } : model
		);
		await saveModels(site.id, models);
		this.provider.refresh();
		await this.pushState();
	}

	/** 一次写完整张表，避免逐条保存时互相覆盖。 */
	private async setAllModels(enabled: boolean): Promise<void> {
		const site = getActiveSite();
		if (!site) {
			return;
		}
		const models = getModels(site.id).map((model) => ({ ...model, enabled }));
		await saveModels(site.id, models);
		this.provider.refresh();
		await this.pushState();
	}

	private async changeModelProtocol(modelId: string, apiMode: ProtocolModeName): Promise<void> {
		const site = getActiveSite();
		if (!site) {
			return;
		}
		const updated = await setModelProtocol(site.id, modelId, apiMode);
		if (!updated) {
			return;
		}
		this.provider.refresh();
		await this.pushState();
	}

	/** 把另一个模型的档位套过来；sourceModelId 为 null 表示清除。 */
	private async changeModelEfforts(modelId: string, sourceModelId: string | null): Promise<void> {
		const site = getActiveSite();
		if (!site) {
			return;
		}
		const models = getModels(site.id);
		if (!models.some((model) => model.id === modelId)) {
			return;
		}
		const source = sourceModelId ? models.find((model) => model.id === sourceModelId) : undefined;
		const next = models.map((model) => (model.id === modelId ? withEffortsFrom(model, source) : model));
		await saveModels(site.id, next);
		this.provider.refresh();
		await this.pushState();
	}

	/** 改站点名只是改个显示名，不重新扫模型，也不动当前选中的站点。 */
	private async renameSite(siteId: string, rawName: string): Promise<void> {
		const site = getSites().find((item) => item.id === siteId);
		if (!site) {
			return;
		}
		const activeBefore = getActiveSiteId();
		const name = rawName.trim() || hostOf(site.baseUrl);
		if (name === site.name) {
			return;
		}
		await saveSite({ ...site, name });
		if (activeBefore && activeBefore !== site.id) {
			await setActiveSiteId(activeBefore);
		}
		this.message = `站点已改名为「${name}」。`;
		await this.pushState();
	}

	private async confirmRemoveSite(siteId: string): Promise<void> {
		const site = getSites().find((item) => item.id === siteId);
		if (!site) {
			return;
		}
		const confirmed = await vscode.window.showWarningMessage(
			`移除站点「${site.name}」？它的模型列表和 API Key 都会被删掉，Copilot 里对应的模型会消失。`,
			{ modal: true },
			"移除"
		);
		if (confirmed !== "移除") {
			return;
		}
		await removeSite(siteId, this.secrets);
		this.provider.refresh();
		this.status = "idle";
		this.message = "站点已移除。";
		this.lastScanAt = null;
		await this.pushState();
	}

	private async clear(): Promise<void> {
		const site = getActiveSite();
		if (!site) {
			return;
		}
		const confirmed = await vscode.window.showWarningMessage(
			`清空站点「${site.name}」的模型和 API Key？Copilot 会立即恢复原有模型。`,
			{ modal: true },
			"清空"
		);
		if (confirmed !== "清空") {
			return;
		}
		const remaining: ModelEntry[] = [];
		await saveModels(site.id, remaining);
		await this.secrets.delete(`ucantransit.apiKey.${site.id}`);
		this.provider.refresh();
		this.status = "idle";
		this.message = "已清空，Copilot 已恢复原有模型列表。";
		this.lastScanAt = null;
		await this.pushState();
	}

	private async render(webview: vscode.Webview): Promise<string> {
		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
		const template = vscode.Uri.joinPath(mediaRoot, "panel.html");
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.css"));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "panel.js"));
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join("; ");

		const raw = await vscode.workspace.fs.readFile(template);
		return new TextDecoder()
			.decode(raw)
			.replaceAll("%CSP%", csp)
			.replaceAll("%NONCE%", nonce)
			.replaceAll("%CSS_URI%", cssUri.toString())
			.replaceAll("%SCRIPT_URI%", jsUri.toString());
	}
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
