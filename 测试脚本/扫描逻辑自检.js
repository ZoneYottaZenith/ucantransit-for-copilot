/**
 * 扫描逻辑自检：不启动 VS Code，只验证两件事
 * 1. models.dev 快照能解析，常见模型能命中能力
 * 2. 中转站 /models 的各种返回格式都能正确识别
 *
 * 运行：node 测试脚本/扫描逻辑自检.js
 */

const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

// out 目录里的模块会 require("vscode")，这里只提供用到的那一点点
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return {
			Uri: { joinPath: (base, ...parts) => path.join(base.fsPath ?? base, ...parts) },
			workspace: { fs: { readFile: async (target) => fs.promises.readFile(target) } },
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const { ModelsDevCatalog } = require(path.join(outDir, "modelsDev.js"));
const { scanModels } = require(path.join(outDir, "modelCatalog.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

function serve(routes) {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const route = routes[req.url];
			if (!route) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "not found" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(route));
		});
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({ server, port });
		});
	});
}

async function main() {
	const snapshotPath = path.join(__dirname, "..", "media", "models_dev.json");
	const snapshot = fs.readFileSync(snapshotPath, "utf8");

	const started = Date.now();
	const catalog = ModelsDevCatalog.fromJson(snapshot);
	const elapsed = Date.now() - started;

	check("快照可解析", catalog.size > 1000, `索引 ${catalog.size} 条，用时 ${elapsed}ms`);

	const gpt4o = catalog.find("gpt-4o");
	check("gpt-4o 命中且支持图片", gpt4o && gpt4o.inputImage === true, JSON.stringify(gpt4o));

	const claude = catalog.find("anthropic/claude-sonnet-4-5");
	check(
		"带前缀的 claude 能命中并拿到上下文",
		claude && claude.contextLength && claude.contextLength >= 200000,
		JSON.stringify(claude)
	);

	const deepseek = catalog.find("deepseek-v3");
	check("deepseek-v3 标记支持工具", deepseek && deepseek.toolCalling === true, JSON.stringify(deepseek));

	// 中转站常在官方 id 后面加后缀，模糊匹配要能对回官方模型
	const suffixed = catalog.find("gpt-4o-优化版");
	check("带中文后缀的 id 能模糊命中官方模型", suffixed && suffixed.inputImage === true, JSON.stringify(suffixed));

	// 用一个迷你快照验证“同时命中多个时取最长”，不依赖真实数据里恰好存在这种组合
	const tiny = ModelsDevCatalog.fromJson(
		JSON.stringify({
			demo: {
				models: {
					"demo-model": { limit: { context: 1000 }, tool_call: true },
					"demo-model-pro": { limit: { context: 2000 }, tool_call: true },
				},
			},
		})
	);
	const longestInfo = tiny.find("demo-model-pro-优化版");
	check(
		"同时能命中多个时取最长的官方 id",
		longestInfo && longestInfo.contextLength === 2000,
		`命中=${JSON.stringify(longestInfo)}（短 id 是 1000）`
	);

	check(
		"完全无关的 id 不会被模糊匹配误命中",
		catalog.find("totally-unknown-model-xyz") === undefined,
		JSON.stringify(catalog.find("totally-unknown-model-xyz"))
	);

	// --- 模拟中转站 ---
	const openaiShape = {
		object: "list",
		data: [
			{ id: "gpt-4o", object: "model" },
			{ id: "totally-unknown-model-xyz", object: "model" },
		],
	};
	const ollamaShape = { models: [{ name: "qwen2.5:7b" }, { name: "llava:latest" }] };
	const arrayShape = ["array-model-a", "array-model-b"];

	const first = await serve({
		"/v1/models": openaiShape,
	});
	const second = await serve({ "/v1/models": arrayShape });
	// 只提供 /models（没有 /v1 前缀），用来验证 404 回退
	const third = await serve({ "/models": ollamaShape });

	try {
		const openaiResult = await scanModels(`http://127.0.0.1:${first.port}/v1`, "test-key", catalog);
		check("标准 OpenAI 格式可识别", openaiResult.models.length === 2, JSON.stringify(openaiResult.models));

		const gpt = openaiResult.models.find((m) => m.id === "gpt-4o");
		check("gpt-4o 能力来自 models.dev", gpt && gpt.source === "models.dev" && gpt.vision === true, JSON.stringify(gpt));

		const unknown = openaiResult.models.find((m) => m.id === "totally-unknown-model-xyz");
		check(
			"未知模型保守处理：不误报图片",
			unknown && unknown.vision === false && unknown.source === "default",
			JSON.stringify(unknown)
		);

		const fallback = await scanModels(`http://127.0.0.1:${third.port}`, "test-key", catalog);
		check(
			"未填 /v1 时能回退到 /models 并识别 {models:[]} 格式",
			fallback.models.some((m) => m.id === "qwen2.5:7b") && fallback.models.some((m) => m.id === "llava:latest"),
			JSON.stringify(fallback.models)
		);

		const arrayResult = await scanModels(`http://127.0.0.1:${second.port}/v1`, "test-key", catalog);
		check("裸数组格式可识别", arrayResult.models.length === 2, JSON.stringify(arrayResult.models));

		const llava = fallback.models.find((m) => m.id === "llava:latest");
		check("llava 按名称推断出图片能力", llava && llava.vision === true, JSON.stringify(llava));
	} finally {
		first.server.close();
		second.server.close();
		third.server.close();
	}

	const failed = results.filter((item) => !item.ok);
	for (const item of results) {
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  -> ${item.detail}` : ""}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
	console.error("自检失败：", error);
	process.exitCode = 1;
});
