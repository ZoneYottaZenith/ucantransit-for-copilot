/**
 * 配置读写自检：验证模型表在批量改名/改协议时不会丢数据。
 *
 * 背景：面板「全开/全关」以前是给每个模型各发一条消息，后端每次都要
 * 读一次配置、改一条、写回去，并发交错时会互相覆盖，表现就是状态乱跳、
 * 点了没反应。现在改成一条消息写完整张表，这个脚本守住这条路径。
 *
 * 不启动 VS Code，只 mock 一个内存版的 getConfiguration。
 * 运行：node 测试脚本/配置读写自检.js
 */

const path = require("node:path");
const Module = require("node:module");

/** 内存版配置存储，模拟 settings.json */
const store = {};

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

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return {
			workspace: { getConfiguration },
			ConfigurationTarget: { Global: 1 },
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const config = require(path.join(outDir, "config.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

function makeModels(count) {
	return Array.from({ length: count }, (_, index) => ({
		id: `model-${index + 1}`,
		name: `model-${index + 1}`,
		contextLength: 128000,
		toolCalling: true,
		vision: false,
		reasoning: false,
		source: "default",
		enabled: true,
		apiMode: "openai",
	}));
}

async function main() {
	store.sites = [{ id: "site-a", name: "站点 A", baseUrl: "https://a.example.com/v1" }];
	store.activeSiteId = "site-a";

	// 1. 基础读写
	await config.saveModels("site-a", makeModels(8));
	const readBack = config.getModels("site-a");
	check("存 8 个模型能原样读回", readBack.length === 8, readBack.length);

	// 2. 批量停用：一次写完整张表，8 个全变 false
	const disabled = config.getModels("site-a").map((model) => ({ ...model, enabled: false }));
	await config.saveModels("site-a", disabled);
	const allOff = config.getModels("site-a");
	check("批量停用后全部为 false", allOff.every((model) => model.enabled === false), allOff.map((m) => m.enabled));
	check("批量停用后数量不变", allOff.length === 8, allOff.length);

	// 3. 批量启用：再整体切回来，不能只剩最后一个
	const enabled = config.getModels("site-a").map((model) => ({ ...model, enabled: true }));
	await config.saveModels("site-a", enabled);
	const allOn = config.getModels("site-a");
	check("批量启用后全部为 true", allOn.every((model) => model.enabled === true), allOn.map((m) => m.enabled));

	// 4. 单模型改协议只影响目标模型
	const changed = await config.setModelProtocol("site-a", "model-3", "anthropic");
	const afterProtocol = config.getModels("site-a");
	check("改协议返回目标模型", changed && changed.id === "model-3", changed && changed.id);
	check(
		"只有目标模型协议变了",
		afterProtocol.find((m) => m.id === "model-3").apiMode === "anthropic" &&
			afterProtocol.filter((m) => m.id !== "model-3").every((m) => m.apiMode === "openai"),
		afterProtocol.map((m) => `${m.id}:${m.apiMode}`)
	);
	check("改协议不影响启用状态", afterProtocol.every((m) => m.enabled === true), afterProtocol.map((m) => m.enabled));

	// 5. 旧数据里的 ollama 会被按模型名重新推断
	store.modelsBySite = {
		"site-a": [
			{
				id: "claude-3-opus",
				name: "claude-3-opus",
				contextLength: 200000,
				toolCalling: true,
				vision: true,
				reasoning: true,
				source: "models.dev",
				enabled: true,
				apiMode: "ollama",
			},
		],
	};
	const migrated = config.getModels("site-a")[0];
	check("ollama 协议被重新推断", migrated.apiMode === "anthropic", migrated.apiMode);

	// 6. 多站点互不干扰
	await config.saveModels("site-a", makeModels(2));
	await config.saveModels("site-b", makeModels(5));
	check("两个站点的模型表分开存", config.getModels("site-a").length === 2 && config.getModels("site-b").length === 5, {
		a: config.getModels("site-a").length,
		b: config.getModels("site-b").length,
	});

	for (const item of results) {
		const detail = item.detail === undefined ? "" : `  -> ${JSON.stringify(item.detail)}`;
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${detail}`);
	}
	const passed = results.filter((item) => item.ok).length;
	console.log(`\n${passed}/${results.length} 通过`);
	process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error) => {
	console.error("自检失败：", error);
	process.exitCode = 1;
});
