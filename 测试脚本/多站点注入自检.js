/**
 * 多站点注入自检：验证多个中转站能同时出现在 Copilot 模型选择器里。
 *
 * 背景：以前注入时只读 activeSiteId，切站点等于换整批模型。
 * 现在遍历所有站点，并在 detail/tooltip 里带站点名；
 * 多站点时模型 id 用 `<站点id>::<模型id>` 区分，请求要回到对应站点。
 *
 * 不启动 VS Code，mock 一个内存版 getConfiguration + SecretStorage。
 * 运行：node 测试脚本/多站点注入自检.js
 */

const path = require("node:path");
const Module = require("node:module");

/** 内存版配置存储，模拟 settings.json */
const store = {};
/** 内存版密钥库 */
const secrets = new Map();

function getConfiguration() {
	return {
		get(key, fallback) {
			return key in store ? store[key] : fallback;
		},
		async update(key, value) {
			store[key] = value;
		},
	};
}

/** 记录 provider 真正发出去的请求，用来验证站点路由 */
const sent = [];

const fakeProtocols = {
	PROTOCOL_LABELS: { openai: "Chat Completions", "openai-responses": "Responses", anthropic: "Anthropic", gemini: "Gemini" },
	guessProtocol: () => "openai",
	async sendChat(mode, request) {
		sent.push({ mode, baseUrl: request.baseUrl, apiKey: request.apiKey, modelId: request.modelId });
	},
};

class FakeEventEmitter {
	constructor() {
		this.listeners = [];
		this.event = (listener) => {
			this.listeners.push(listener);
			return { dispose() {} };
		};
	}
	fire() {
		for (const listener of this.listeners) {
			listener();
		}
	}
	dispose() {
		this.listeners = [];
	}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return {
			workspace: { getConfiguration },
			env: { language: "zh-cn" },
			ConfigurationTarget: { Global: 1 },
			EventEmitter: FakeEventEmitter,
			ThemeIcon: class ThemeIcon {
				constructor(id) {
					this.id = id;
				}
			},
			LanguageModelTextPart: class LanguageModelTextPart {
				constructor(value) {
					this.value = value;
				}
			},
			Disposable: class Disposable {
				constructor(fn) {
					this.dispose = fn;
				}
			},
		};
	}
	// provider.ts 直接 import 了 ./protocols，这里换成假的，好截获请求参数
	if (request === "./protocols" && parent && parent.filename.endsWith("provider.js")) {
		return fakeProtocols;
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const config = require(path.join(outDir, "config.js"));
const { TransitModelProvider } = require(path.join(outDir, "provider.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

/** 只实现 provider 用到的那几个方法 */
const fakeSecrets = {
	async get(key) {
		return secrets.get(key);
	},
	async store(key, value) {
		secrets.set(key, value);
	},
	async delete(key) {
		secrets.delete(key);
	},
};

function model(id, name) {
	return {
		id,
		name,
		contextLength: 128000,
		toolCalling: true,
		vision: false,
		reasoning: false,
		source: "default",
		enabled: true,
		apiMode: "openai",
	};
}

function reset(sites, modelsBySite, keys) {
	for (const key of Object.keys(store)) {
		delete store[key];
	}
	secrets.clear();
	sent.length = 0;
	store.enabled = true;
	store.sites = sites;
	store.activeSiteId = sites[0] ? sites[0].id : "";
	store.modelsBySite = modelsBySite;
	for (const [siteId, key] of Object.entries(keys ?? {})) {
		secrets.set(`ucantransit.apiKey.${siteId}`, key);
	}
}

function fakeToken() {
	return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
}

function fakeProgress() {
	return { report() {} };
}

async function main() {
	// ---- 场景 1：两个站点同时注入 ----
	reset(
		[
			{ id: "site-a", name: "站A", baseUrl: "https://a.example.com" },
			{ id: "site-b", name: "站B", baseUrl: "https://b.example.com" },
		],
		{
			"site-a": [model("gpt-4o-mini", "GPT-4o mini"), model("same-model", "同名模型")],
			"site-b": [model("same-model", "同名模型"), model("claude-x", "Claude X")],
		},
		{ "site-a": "key-a", "site-b": "key-b" }
	);

	let provider = new TransitModelProvider(fakeSecrets);
	let infos = await provider.provideLanguageModelChatInformation();

	check("两个站点的模型都出现", infos.length === 4, `实际 ${infos.length} 条`);
	check(
		"模型 id 带站点前缀",
		infos.every((info) => info.id.includes("::")),
		infos.map((info) => info.id).join(", ")
	);
	check(
		"同名模型不会互相顶掉",
		new Set(infos.map((info) => info.id)).size === infos.length,
		infos.map((info) => info.id).join(", ")
	);
	check(
		"detail 里带站点名",
		infos.some((info) => info.detail.startsWith("站A · ")) && infos.some((info) => info.detail.startsWith("站B · ")),
		infos.map((info) => info.detail).join(" | ")
	);
	check(
		"模型名里带站点名（前缀，保证同站聚在一起）",
		infos.every((info) => info.name.startsWith("[站A] ") || info.name.startsWith("[站B] ")),
		infos.map((info) => info.name).join(" | ")
	);
	check(
		"tooltip 里带站点名和地址",
		infos.some((info) => info.tooltip.includes("站A") && info.tooltip.includes("https://a.example.com")),
		infos[0] && infos[0].tooltip
	);

	// 请求要回到模型所属的站点，而不是当前选中的站点
	const siteBModel = infos.find((info) => info.id === "site-b::claude-x");
	await provider.provideLanguageModelChatResponse(
		siteBModel,
		[{ role: 1, content: [{ value: "hi" }] }],
		{ tools: [], toolMode: undefined },
		fakeProgress(),
		fakeToken()
	);
	check(
		"请求发往模型所属站点",
		sent.length === 1 && sent[0].baseUrl === "https://b.example.com" && sent[0].apiKey === "key-b",
		JSON.stringify(sent[0])
	);
	check("上游拿到的是纯模型 id", sent[0] && sent[0].modelId === "claude-x", sent[0] && sent[0].modelId);

	// ---- 场景 2：只剩一个站点时沿用纯模型 id（老用户选中项不丢） ----
	reset(
		[{ id: "site-a", name: "站A", baseUrl: "https://a.example.com" }],
		{ "site-a": [model("gpt-4o-mini", "GPT-4o mini")] },
		{ "site-a": "key-a" }
	);

	provider = new TransitModelProvider(fakeSecrets);
	infos = await provider.provideLanguageModelChatInformation();
	check("单站点时 id 不带前缀", infos.length === 1 && infos[0].id === "gpt-4o-mini", infos.map((i) => i.id).join(", "));
	check("单站点时 detail 仍带站点名", infos[0].detail.startsWith("站A · "), infos[0].detail);
	check("单站点时模型名也带站点名", infos[0].name === "[站A] GPT-4o mini", infos[0].name);

	// ---- 场景 3：没配密钥的站点，模型仍显示但要标警告 ----
	reset(
		[
			{ id: "site-a", name: "站A", baseUrl: "https://a.example.com" },
			{ id: "site-c", name: "站C", baseUrl: "https://c.example.com" },
		],
		{ "site-a": [model("m1", "M1")], "site-c": [model("m2", "M2")] },
		{ "site-a": "key-a" }
	);

	provider = new TransitModelProvider(fakeSecrets);
	infos = await provider.provideLanguageModelChatInformation();
	const noKey = infos.find((info) => info.id === "site-c::m2");
	check("缺密钥的站点也列出模型", Boolean(noKey), infos.map((i) => i.id).join(", "));
	check("缺密钥时有警告图标", noKey && noKey.statusIcon && noKey.statusIcon.id === "warning", noKey && noKey.statusIcon && noKey.statusIcon.id);
	check("缺密钥时 detail 提示补 Key", noKey && noKey.detail.includes("未配置 API Key"), noKey && noKey.detail);

	// ---- 场景 3.5：停用的站点不注入，重新启用后回来 ----
	reset(
		[
			{ id: "site-a", name: "站A", baseUrl: "https://a.example.com" },
			{ id: "site-b", name: "站B", baseUrl: "https://b.example.com", enabled: false },
		],
		{ "site-a": [model("m1", "M1")], "site-b": [model("m2", "M2")] },
		{ "site-a": "key-a", "site-b": "key-b" }
	);

	provider = new TransitModelProvider(fakeSecrets);
	infos = await provider.provideLanguageModelChatInformation();
	check("停用的站点不注入", infos.length === 1 && infos[0].name === "[站A] M1", infos.map((i) => i.name).join(", "));
	check("只剩一个启用站点时 id 不带前缀", infos.length === 1 && infos[0].id === "m1", infos.map((i) => i.id).join(", "));

	await config.setSiteEnabled("site-b", true);
	check(
		"改启停只动目标站点",
		store.sites.find((site) => site.id === "site-a").enabled === true &&
			store.sites.find((site) => site.id === "site-b").enabled === true,
		JSON.stringify(store.sites)
	);
	infos = await provider.provideLanguageModelChatInformation();
	check("重新启用后模型回来", infos.length === 2, infos.map((i) => i.name).join(", "));

	// ---- 场景 3.6：站点顺序稳定，编号才不会乱 ----
	reset(
		[
			{ id: "site-a", name: "站A", baseUrl: "https://a.example.com" },
			{ id: "site-b", name: "站B", baseUrl: "https://b.example.com" },
			{ id: "site-c", name: "站C", baseUrl: "https://c.example.com" },
		],
		{},
		{}
	);

	await config.saveSite({ id: "site-a", name: "站A改名", baseUrl: "https://a.example.com" });
	check(
		"改已有站点信息不会挪位置",
		store.sites.map((site) => site.id).join(",") === "site-a,site-b,site-c",
		store.sites.map((site) => site.id).join(",")
	);
	await config.saveSite({ id: "site-d", name: "站D", baseUrl: "https://d.example.com" });
	check(
		"新站点追加在末尾",
		store.sites.map((site) => site.id).join(",") === "site-a,site-b,site-c,site-d",
		store.sites.map((site) => site.id).join(",")
	);

	// ---- 场景 4：总开关关掉后完全恢复 ----
	store.enabled = false;
	infos = await provider.provideLanguageModelChatInformation();
	check("关闭开关后不注入任何模型", infos.length === 0, `实际 ${infos.length} 条`);

	// ---- 输出 ----
	let failed = 0;
	for (const item of results) {
		if (!item.ok) {
			failed += 1;
		}
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok ? "" : ` -> ${item.detail ?? ""}`}`);
	}
	console.log(`\n${results.length - failed}/${results.length} 通过`);
	process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
