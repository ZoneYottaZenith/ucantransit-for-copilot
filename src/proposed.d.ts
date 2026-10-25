declare module "vscode" {
	/**
	 * chatProvider 提案字段：让模型出现在选择器里、标记为 BYOK，并允许模型级配置下拉。
	 * 只补可选字段，不改动稳定 API 的既有定义。
	 */
	export interface LanguageModelChatInformation {
		readonly isUserSelectable?: boolean;
		readonly isBYOK?: boolean;
		readonly configurationSchema?: Record<string, unknown>;
		/** 模型选择器里的状态图标，用来提示未配置等异常。 */
		readonly statusIcon?: vscode.ThemeIcon;
	}
}
