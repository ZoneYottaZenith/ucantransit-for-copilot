import * as vscode from "vscode";
import { TransitModelProvider } from "./provider";
import { PanelViewProvider } from "./panel";
import { ReasoningCatalog } from "./reasoningCatalog";

/**
 * UCanTransit：把任意 OpenAI 兼容中转站接进 Copilot。
 *
 * 设计原则：对 Copilot 只做“增加模型”，关闭开关或断开后即恢复原样，
 * 不修改任何 Copilot 自身的设置或文件。
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const provider = new TransitModelProvider(context.secrets);
	context.subscriptions.push(provider);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider("ucantransit", provider)
	);

	// 注册后先主动推一次，让模型不依赖 Copilot 的拉取时机就能出现。
	provider.refresh();
	context.subscriptions.push(refreshAfterCopilotActivation(provider));

	const panel = new PanelViewProvider(context.extensionUri, context.secrets, provider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, panel, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// 思考档位从缓存/网络加载，不阻塞激活
	void ReasoningCatalog.load(context, `UCanTransit/${context.extension.packageJSON.version ?? "0.0.0"}`)
		.then((catalog) => panel.setReasoningCatalog(catalog))
		.catch(() => undefined);

	context.subscriptions.push(
		vscode.commands.registerCommand("ucantransit.openPanel", async () => {
			await vscode.commands.executeCommand(`${PanelViewProvider.viewType}.focus`);
		}),
		vscode.commands.registerCommand("ucantransit.connect", async () => {
			await vscode.commands.executeCommand(`${PanelViewProvider.viewType}.focus`);
		}),
		vscode.commands.registerCommand("ucantransit.refresh", () => {
			provider.refresh();
		})
	);

	// 配置或密钥变化时，面板和 Copilot 的模型列表一起更新
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("ucantransit")) {
				provider.refresh();
				void panel.pushState();
			}
		}),
		context.secrets.onDidChange(() => {
			provider.refresh();
			void panel.pushState();
		})
	);
}

export function deactivate(): void {
	// 所有资源都挂在 subscriptions 上，无需额外清理
}

/**
 * Copilot Chat 激活前会缓存一份模型信息，那份里没有 configurationSchema，
 * 于是选择器里看不到思考模式下拉。等它激活完再推一次，把缓存顶掉。
 */
function refreshAfterCopilotActivation(provider: TransitModelProvider): vscode.Disposable {
	let disposed = false;

	Promise.resolve(vscode.extensions.getExtension("github.copilot-chat")?.activate())
		.then(() => {
			if (!disposed) {
				provider.refresh();
			}
		})
		.catch(() => {
			// Copilot 激活失败不影响我们自己
		});

	return new vscode.Disposable(() => {
		disposed = true;
	});
}
