/**
 * 刷新合并自检：验证「刷新」只更新上游事实，不冲掉用户设置。
 *
 * 运行：node 测试脚本/刷新合并自检.js
 */

const path = require("node:path");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return {
			LanguageModelTextPart: class {},
			LanguageModelToolCallPart: class {},
			LanguageModelDataPart: class {},
			Uri: { joinPath: () => "" },
			workspace: { fs: { readFile: async () => new Uint8Array() } },
		};
	}
	return originalLoad.call(this, request, parent, isMain);
};

const outDir = path.join(__dirname, "..", "out");
const { mergeModels, withEffortsFrom } = require(path.join(outDir, "modelCatalog.js"));

const results = [];
function check(name, condition, detail) {
	results.push({ name, ok: Boolean(condition), detail });
}

function model(id, patch) {
	return {
		id,
		name: id,
		contextLength: 128000,
		toolCalling: true,
		vision: false,
		reasoning: false,
		source: "models.dev",
		enabled: true,
		apiMode: "openai",
		...patch,
	};
}

function find(list, id) {
	return list.find((item) => item.id === id);
}

function main() {
	// 用户改过的东西：停用、手动协议、单独的温度
	const previous = [
		model("gpt-5.5", { enabled: false, apiMode: "openai", temperature: 0.3 }),
		model("claude-sonnet-4", { apiMode: "anthropic", topP: 0.8 }),
		model("removed-model", {}),
	];

	// 上游这次给的结果：上下文变大、新增一个、下架一个
	const scanned = [
		model("gpt-5.5", { contextLength: 2000000, apiMode: "openai-responses", vision: true }),
		model("claude-sonnet-4", { apiMode: "anthropic" }),
		model("brand-new-model", { apiMode: "openai" }),
	];

	const merged = mergeModels(previous, scanned);

	check("模型数量按上游这次的结果", merged.length === 3, merged.map((m) => m.id));
	check("下架的模型被移除", !find(merged, "removed-model"));
	check("新模型出现在列表里", Boolean(find(merged, "brand-new-model")));

	const gpt = find(merged, "gpt-5.5");
	check("保留停用状态", gpt.enabled === false, gpt.enabled);
	check("保留手动改的协议", gpt.apiMode === "openai", gpt.apiMode);
	check("保留单独设的温度", gpt.temperature === 0.3, gpt.temperature);
	check("上下文用上游新值", gpt.contextLength === 2000000, gpt.contextLength);
	check("能力用上游新值", gpt.vision === true, gpt.vision);

	const claude = find(merged, "claude-sonnet-4");
	check("保留 top_p", claude.topP === 0.8, claude.topP);
	check("保留协议", claude.apiMode === "anthropic", claude.apiMode);
	check("没设过的温度保持未设置", claude.temperature === undefined, claude.temperature);

	const fresh = find(merged, "brand-new-model");
	check("新模型默认启用", fresh.enabled === true, fresh.enabled);
	check("新模型用推断协议", fresh.apiMode === "openai", fresh.apiMode);

	// 首次扫描：没有旧数据，不该出问题
	const firstRun = mergeModels([], scanned);
	check("首次扫描正常返回", firstRun.length === 3, firstRun.length);
	check("首次扫描全部默认启用", firstRun.every((m) => m.enabled === true));

	// 上游完全没变：结果应与旧配置等价（除能力字段）
	const same = mergeModels(previous, previous.map((m) => ({ ...m })));
	check("上游没变化时数量不变", same.length === previous.length, same.length);
	check(
		"上游没变化时用户设置还在",
		find(same, "gpt-5.5").enabled === false && find(same, "claude-sonnet-4").topP === 0.8
	);

	// ---------- 手动套用档位 ----------
	const source = model("gpt-5.5", {
		supportedEfforts: ["low", "medium", "high"],
		defaultEffort: "medium",
		effortMandatory: false,
	});
	const target = model("gpt-reserve", {});
	const applied = withEffortsFrom(target, source);
	check("套用后拿到档位", applied.supportedEfforts.join(",") === "low,medium,high", applied.supportedEfforts);
	check("套用后拿到默认档", applied.defaultEffort === "medium", applied.defaultEffort);
	check("套用后拿到可关闭标记", applied.effortMandatory === false, applied.effortMandatory);
	check("套用后标记为手动", applied.effortManual === true, applied.effortManual);
	check("套用后标记支持推理", applied.reasoning === true, applied.reasoning);
	check("套用不改 id 和协议", applied.id === "gpt-reserve" && applied.apiMode === "openai");

	// 源模型没档位 = 清除
	const cleared = withEffortsFrom(applied, model("empty", {}));
	check(
		"源模型无档位时清除干净",
		cleared.supportedEfforts === undefined && cleared.effortManual === undefined && cleared.defaultEffort === undefined,
		cleared
	);
	const clearedByNull = withEffortsFrom(applied, undefined);
	check("传空对象等于清除", clearedByNull.supportedEfforts === undefined, clearedByNull.supportedEfforts);

	// 刷新时手动套用的档位不能被上游冲掉
	const manualBefore = [applied];
	const manualAfter = mergeModels(manualBefore, [model("gpt-reserve", {})]);
	check(
		"刷新后手动档位仍在",
		manualAfter[0].supportedEfforts?.join(",") === "low,medium,high" && manualAfter[0].effortManual === true,
		manualAfter[0].supportedEfforts
	);

	// 上游这次自己给出了档位，手动套用的也算用户意图，仍然保留
	const upstreamHasEfforts = mergeModels(manualBefore, [
		model("gpt-reserve", { supportedEfforts: ["max"], defaultEffort: "max" }),
	]);
	check(
		"手动档位优先于上游新值",
		upstreamHasEfforts[0].supportedEfforts.join(",") === "low,medium,high",
		upstreamHasEfforts[0].supportedEfforts
	);

	// 没标记手动的模型，刷新时用上游新值
	const autoModel = model("auto-model", { supportedEfforts: ["low"] });
	const autoAfter = mergeModels([autoModel], [model("auto-model", { supportedEfforts: ["low", "high"] })]);
	check("自动档位跟随上游", autoAfter[0].supportedEfforts.join(",") === "low,high", autoAfter[0].supportedEfforts);

	for (const item of results) {
		const detail = item.detail === undefined ? "" : `  -> ${JSON.stringify(item.detail)}`;
		console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${detail}`);
	}
	const passed = results.filter((item) => item.ok).length;
	console.log(`\n${passed}/${results.length} 通过`);
	process.exitCode = passed === results.length ? 0 : 1;
}

main();
