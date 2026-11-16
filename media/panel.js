const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const ui = {
	enabled: $("enabled"),
	subtitleText: $("subtitleText"),
	version: $("version"),
	newSite: $("newSite"),
	removeSite: $("removeSite"),
	toggleSite: $("toggleSite"),
	siteSelect: $("siteSelect"),
	siteName: $("siteName"),
	siteNameHint: $("siteNameHint"),
	baseUrl: $("baseUrl"),
	urlHint: $("urlHint"),
	apiKey: $("apiKey"),
	toggleKey: $("toggleKey"),
	keyHint: $("keyHint"),
	connect: $("connect"),
	badge: $("badge"),
	meta: $("meta"),
	search: $("search"),
	modelList: $("modelList"),
	empty: $("empty"),
	selectAll: $("selectAll"),
	selectNone: $("selectNone"),
	rescan: $("rescan"),
	openSettings: $("openSettings"),
	wipeAll: $("wipeAll"),
	toasts: $("toasts"),
};

/** 下拉里显示的协议名称，按用户指定的写法。 */
const PROTOCOL_LABELS = {
	openai: "Chat Completions",
	"openai-responses": "Responses",
	anthropic: "Anthropic Messages",
	gemini: "Gemini",
};

const PROTOCOL_TITLES = {
	openai: "OpenAI Chat Completions，最通用，兼容性最好",
	"openai-responses": "OpenAI Responses，GPT 新代与 o 系列的原生形态",
	anthropic: "Anthropic Messages，Claude 原生形态",
	gemini: "Gemini 原生，generateContent",
};

const DEFAULT_URL_HINT = "填到 /v1 即可，模型列表路径会自动补全。";
const DEFAULT_KEY_HINT = "密钥存在系统密钥库，不写进设置文件。";
/** 新增态在下拉里占的那一条，输入名字时直接改它的文字 */
const DRAFT_OPTION_ID = "siteDraftOption";

let state = null;
let keyword = "";
let addingNew = false;
let lastStatus = null;
let lastMessage = "";
/** 上一次渲染的站点，用来判断是不是刚切了站点 */
let lastSiteId = null;
/** 刚提交改名、还在等后端确认的名字；确认后由前端自己弹提示 */
let pendingRename = null;
/** 已经提交过的 Key，免得同一个值每次失焦都发一遍 */
let hintedKey = "";
/** 正等回包的地址和 Key，后端处理完就提示 */
let pendingUrl = "";
let pendingKey = "";
/** 新增态下是否已经把草稿站点提交下去了，避免失焦多次重复建站 */
let draftRequested = false;
/** 点到但还没等到后端确认的勾选；对上了才提示，避免“界面动了其实没存” */
const pendingToggles = new Map();
let pendingAll = null;
let toggleSeq = 0;
/** 模型列表的内容指纹：内容没变就不白重建一遍 */
let lastModelsKey = "";

const send = (message) => vscode.postMessage(message);

function toast(text, kind = "info") {
	if (!text) {
		return;
	}
	const el = document.createElement("div");
	el.className = `toast ${kind}`;
	el.textContent = text;
	ui.toasts.appendChild(el);
	requestAnimationFrame(() => el.classList.add("show"));
	setTimeout(() => {
		el.classList.remove("show");
		setTimeout(() => el.remove(), 220);
	}, 2600);
}

function contextLabel(length) {
	if (!length) {
		return "未知上下文";
	}
	if (length >= 1000 * 1000) {
		const value = length / (1000 * 1000);
		return `${Number.isInteger(value) ? value : value.toFixed(1)}M 上下文`;
	}
	return `${Math.round(length / 1000)}K 上下文`;
}

function formatTime(timestamp) {
	if (!timestamp) {
		return "";
	}
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function makeTag(text, className) {
	const span = document.createElement("span");
	span.className = className ? `tag ${className}` : "tag";
	span.textContent = text;
	return span;
}

/**
 * 切换站点后，把跟着变了的那几块淡入一次。
 * 只动透明度和位移，不碰布局和滚动位置。
 */
function playSiteSwap() {
	const blocks = document.querySelectorAll(".wrap > .card, .wrap > .models");
	blocks.forEach((block) => {
		block.classList.remove("site-swap");
		void block.offsetWidth; // 强制重排，让同名动画能重播
		block.classList.add("site-swap");
	});
}

/** 下拉里一个站点长什么样，渲染和实时改名共用同一套写法。 */
function siteOptionText(order, name, disabled) {
	const dot = disabled ? "⚪" : "🟢";
	return disabled ? `${order}. ${name}${dot}（已停用）` : `${order}. ${name}${dot}`;
}

function hostOfUrl(url) {
	try {
		return new URL(url).host;
	} catch {
		return (url || "").trim();
	}
}

function renderSites(sites, activeId) {
	ui.siteSelect.replaceChildren();
	// 新站点的序号接在最后一个已存站点后面；名字还没填就先把位置占着
	const draftText = (order) => {
		const label = draftSiteLabel();
		return label ? `${order}. ${label}` : `${order}. （等待输入站点名称）`;
	};
	if (sites.length === 0 && !addingNew) {
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "还没有站点，先填地址和 Key";
		ui.siteSelect.appendChild(option);
		ui.siteSelect.disabled = true;
		ui.removeSite.disabled = true;
		ui.toggleSite.disabled = true;
		ui.toggleSite.textContent = "停用";
		return;
	}
	// 新增态单独占一项，否则下拉仍勾着上一个站点，看着像新增没点上
	if (addingNew) {
		const draft = document.createElement("option");
		draft.id = DRAFT_OPTION_ID;
		draft.value = "";
		draft.textContent = draftText(sites.length + 1);
		draft.selected = true;
		ui.siteSelect.appendChild(draft);
	}
	sites.forEach((site, index) => {
		const option = document.createElement("option");
		option.value = site.id;
		// 序号按列表顺序走：先加的在前，删掉中间一个后面的自动顶上；只出现在这个下拉里
		option.textContent = siteOptionText(index + 1, site.name, site.enabled === false);
		option.title = site.baseUrl;
		option.selected = !addingNew && site.id === activeId;
		ui.siteSelect.appendChild(option);
	});
	ui.siteSelect.disabled = false;
	const active = sites.find((site) => site.id === activeId);
	// 新增态下没有「当前站点」可言，停用和移除都先收起来
	ui.removeSite.disabled = addingNew;
	ui.toggleSite.disabled = addingNew || !active;
	ui.toggleSite.textContent = active && active.enabled === false ? "启用" : "停用";
}

/** 新站点最终会用什么名字：填了名字用名字，没填就用地址的域名，跟后端一致。 */
function draftSiteLabel() {
	const name = ui.siteName.value.trim();
	if (name) {
		return name;
	}
	const url = ui.baseUrl.value.trim();
	if (!url) {
		return "";
	}
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** 边输入边改下拉里那一行：新增时改草稿项，改旧站点名时改它自己那一项。 */
function refreshSelectText() {
	if (!state) {
		return;
	}
	if (addingNew) {
		const draft = ui.siteSelect.querySelector(`#${DRAFT_OPTION_ID}`);
		if (!draft) {
			return;
		}
		const order = state.sites.length + 1;
		const label = draftSiteLabel();
		draft.textContent = label ? `${order}. ${label}` : `${order}. （等待输入站点名称）`;
		return;
	}
	const siteId = state.activeSiteId;
	const index = state.sites.findIndex((item) => item.id === siteId);
	const site = state.sites[index];
	const option = siteId ? ui.siteSelect.querySelector(`option[value="${siteId}"]`) : null;
	if (!site || !option) {
		return;
	}
	// 输入框里的就是即将生效的名字；清空时后端会回退成域名，这里也先按域名预览
	const name = ui.siteName.value.trim() || hostOfUrl(site.baseUrl);
	option.textContent = siteOptionText(index + 1, name, site.enabled === false);
}

/**
 * 档位套用：中转站自己改了模型 id 时，档位匹配不上，允许从本站其他模型借一份。
 *
 * 返回两个节点：head 里的小按钮，以及行下方点开才展开的单选面板。
 * 没有候选可借、也没手动设过时返回 null，不占地方。
 */
function buildEffortBlock(model, allModels) {
	const current = Array.isArray(model.supportedEfforts) ? model.supportedEfforts : [];
	const currentKey = current.join("/");
	const candidates = [];
	const seen = new Set();
	for (const item of allModels) {
		if (item.id === model.id) {
			continue;
		}
		const efforts = Array.isArray(item.supportedEfforts) ? item.supportedEfforts : [];
		if (efforts.length === 0) {
			continue;
		}
		const key = efforts.join("/");
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		candidates.push({ efforts, sourceId: item.id, sourceName: item.name || item.id });
	}
	// 上游已经给了档位就不用再挂按钮；只有没档位、或之前手动套用过（要改回/清除）才显示
	const needsPicker = current.length === 0 || model.effortManual === true;
	if (candidates.length === 0 || !needsPicker) {
		return null;
	}

	const button = document.createElement("button");
	button.type = "button";
	button.className = "chip-btn effort-btn";
	button.textContent = current.length > 0 ? "改档位" : "设档位";
	button.title = "套用本站其他模型的思考档位";

	const panel = document.createElement("div");
	panel.className = "effort-panel";
	panel.hidden = true;

	button.addEventListener("click", (event) => {
		event.preventDefault();
		panel.hidden = !panel.hidden;
		button.textContent = panel.hidden ? (current.length > 0 ? "改档位" : "设档位") : "收起";
	});

	const groupName = `effort-${model.id}`;
	const markActive = () => {
		for (const option of panel.querySelectorAll(".effort-option")) {
			option.classList.toggle("active", option.querySelector("input").checked);
		}
	};

	for (const candidate of candidates) {
		const option = document.createElement("label");
		option.className = "effort-option";

		const radio = document.createElement("input");
		radio.type = "radio";
		radio.name = groupName;
		// 当前生效的就是这一组，打开时就勾上
		radio.checked = currentKey !== "" && candidate.efforts.join("/") === currentKey;
		if (radio.checked) {
			option.classList.add("active");
		}
		radio.addEventListener("change", () => {
			markActive();
			send({ type: "setModelEfforts", modelId: model.id, sourceModelId: candidate.sourceId });
			toast(`${model.id} 套用了 ${candidate.efforts.join("/")} 档位`, "success");
		});

		const label = document.createElement("span");
		label.className = "effort-option-text";
		label.textContent = candidate.efforts.join(" / ");
		const source = document.createElement("span");
		source.className = "effort-source";
		source.textContent = `来自 ${candidate.sourceName}`;
		option.append(radio, label, source);

		panel.appendChild(option);
	}

	if (model.effortManual === true) {
		const reset = document.createElement("label");
		reset.className = "effort-option reset";

		const radio = document.createElement("input");
		radio.type = "radio";
		radio.name = groupName;
		radio.addEventListener("change", () => {
			markActive();
			send({ type: "setModelEfforts", modelId: model.id, sourceModelId: null });
			toast(`${model.id} 已恢复自动识别的档位`);
		});

		const text = document.createElement("span");
		text.className = "effort-option-text";
		text.textContent = "恢复自动识别";
		reset.append(radio, text);
		panel.appendChild(reset);

		if (!currentKey) {
			radio.checked = true;
			reset.classList.add("active");
		}
	}

	return { button, panel };
}

/** 列表内容指纹：模型数组加搜索词，任何一个变了就得重画。 */
function modelListKey(models) {
	return `${keyword}\u0000${JSON.stringify(models)}`;
}

/** 先自己把勾翻了，别干等后端；存没存上以后端回包为准。 */
function applyLocalToggle(modelId, enabled) {
	if (!state) {
		return;
	}
	state.models = state.models.map((item) => (item.id === modelId ? { ...item, enabled } : item));
	// 界面此刻就是这个样子，同步指纹，回包时能直接跳过重建
	lastModelsKey = modelListKey(state.models);
	const token = ++toggleSeq;
	pendingToggles.set(modelId, { enabled, token });
	send({ type: "toggleModel", modelId, enabled });
	// 后端一声不璽时也别让人一直以为存上了
	window.setTimeout(() => {
		const current = pendingToggles.get(modelId);
		if (!current || current.token !== token) {
			return;
		}
		pendingToggles.delete(modelId);
		if (!state) {
			return;
		}
		state.models = state.models.map((item) =>
			item.id === modelId ? { ...item, enabled: !enabled } : item
		);
		lastModelsKey = "";
		renderModels(state.models);
		toast(`${modelId} 保存失败，已恢复原状`, "error");
	}, 6000);
}

/** 全开/全关：一次翻完所有勾，同样等后端回包再提示。 */
function applyLocalAll(enabled) {
	if (!state || state.models.length === 0) {
		return;
	}
	// 记下原样，万一后端没回话要按原样退回去，不能一律取反
	const original = new Map(state.models.map((item) => [item.id, item.enabled !== false]));
	state.models = state.models.map((item) => ({ ...item, enabled }));
	lastModelsKey = modelListKey(state.models);
	for (const box of ui.modelList.querySelectorAll(".model-check")) {
		box.checked = enabled;
		box.title = enabled ? "已注入 Copilot" : "已停用";
	}
	// 批量会盖掉逐个勾选，旧的不确认了
	pendingToggles.clear();
	const token = ++toggleSeq;
	pendingAll = { enabled, token };
	send({ type: "setAllModels", enabled });
	window.setTimeout(() => {
		if (!pendingAll || pendingAll.token !== token) {
			return;
		}
		pendingAll = null;
		if (!state) {
			return;
		}
		state.models = state.models.map((item) => ({
			...item,
			enabled: original.get(item.id) ?? item.enabled,
		}));
		lastModelsKey = "";
		renderModels(state.models);
		toast("批量切换没等到确认，已恢复原状", "error");
	}, 6000);
}

/** 后端把状态推回来了：对得上就是真存上了，这时才提示。 */
function reconcilePending(next) {
	if (pendingAll) {
		const want = pendingAll.enabled;
		if (next.status === "error") {
			pendingAll = null;
			return;
		}
		const done =
			next.models.length > 0 && next.models.every((item) => (item.enabled !== false) === want);
		if (!done) {
			return;
		}
		const count = next.models.length;
		pendingAll = null;
		toast(
			want
				? `已启用全部 ${count} 个模型`
				: `已停用全部 ${count} 个模型，Copilot 里只会保留开启的`
		);
		return;
	}
	if (pendingToggles.size === 0) {
		return;
	}
	if (next.status === "error") {
		pendingToggles.clear();
		return;
	}
	const actual = new Map(next.models.map((item) => [item.id, item.enabled !== false]));
	const confirmed = [];
	for (const [modelId, want] of [...pendingToggles]) {
		if (actual.get(modelId) === want.enabled) {
			pendingToggles.delete(modelId);
			confirmed.push({ modelId, enabled: want.enabled });
		}
	}
	if (confirmed.length === 0) {
		return;
	}
	if (confirmed.length === 1) {
		toast(`${confirmed[0].modelId} ${confirmed[0].enabled ? "已启用" : "已停用"}`);
	} else {
		toast(`已更新 ${confirmed.length} 个模型`);
	}
}

function renderModels(models) {
	// 内容没变就直接返回：勾一个不该把整个列表推倒重来
	const key = modelListKey(models);
	if (key === lastModelsKey) {
		return;
	}
	lastModelsKey = key;
	ui.modelList.replaceChildren();
	const visible = models.filter(
		(model) => !keyword || model.id.toLowerCase().includes(keyword.toLowerCase())
	);

	if (models.length === 0) {
		ui.empty.textContent = "填好地址和 Key，点上面的按钮开始读取。";
		ui.empty.style.display = "block";
	} else if (visible.length === 0) {
		ui.empty.textContent = "没有匹配的模型";
		ui.empty.style.display = "block";
	} else {
		ui.empty.style.display = "none";
	}

	for (const model of visible) {
		const item = document.createElement("li");
		item.className = "model";

		const head = document.createElement("div");
		head.className = "model-head";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "model-check";
		checkbox.checked = model.enabled !== false;
		checkbox.title = checkbox.checked ? "已注入 Copilot" : "已停用";
		checkbox.addEventListener("change", () => {
			const enabled = checkbox.checked;
			checkbox.title = enabled ? "已注入 Copilot" : "已停用";
			applyLocalToggle(model.id, enabled);
		});

		const id = document.createElement("span");
		id.className = "model-id";
		id.textContent = model.id;
		id.title = model.id;

		const protocol = document.createElement("select");
		protocol.className = "model-protocol";
		protocol.title = "这个模型的请求协议，选错会在发送失败时自动换回 Chat";
		for (const [value, label] of Object.entries(PROTOCOL_LABELS)) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = label;
			option.title = PROTOCOL_TITLES[value];
			protocol.appendChild(option);
		}
		protocol.value = PROTOCOL_LABELS[model.apiMode] ? model.apiMode : "openai";
		protocol.addEventListener("change", () => {
			send({ type: "setModelProtocol", modelId: model.id, apiMode: protocol.value });
			toast(`${model.id} 改用 ${PROTOCOL_LABELS[protocol.value]} 协议`);
		});

		const effort = buildEffortBlock(model, models);

		head.append(checkbox, id);
		if (effort) {
			head.append(effort.button);
		}
		head.append(protocol);
		item.appendChild(head);

		const body = document.createElement("div");
		body.className = "model-body";
		body.appendChild(makeTag(contextLabel(model.contextLength), "ctx"));
		if (model.toolCalling) {
			body.appendChild(makeTag("工具"));
		}
		if (model.vision) {
			body.appendChild(makeTag("图片"));
		}
		if (model.reasoning) {
			body.appendChild(makeTag("推理"));
		}
		if (model.supportedEfforts && model.supportedEfforts.length) {
			body.appendChild(
				makeTag(`档位 ${model.supportedEfforts.join("/")}${model.effortManual === true ? " (手动)" : ""}`, model.effortManual === true ? "manual" : "")
			);
		}
		if (model.source !== "models.dev") {
			const label =
				model.source === "upstream"
					? "上游声明"
					: model.source === "heuristic"
						? "按名称推断"
						: "默认值";
			body.appendChild(makeTag(label, "unknown"));
		}
		// 对话时被上游拒过的参数，之后就不发了；刷新模型列表会重新尝试
		if (model.thinkingUnsupported || model.toolUnsupported) {
			const blocked = [model.thinkingUnsupported ? "思考" : "", model.toolUnsupported ? "工具" : ""]
				.filter(Boolean)
				.join("/");
			body.appendChild(makeTag(`线路拒绝${blocked}参数`, "unknown"));
		}
		item.appendChild(body);

		if (effort) {
			item.appendChild(effort.panel);
		}

		ui.modelList.appendChild(item);
	}
}

function render(next) {
	const previousStatus = lastStatus;
	lastStatus = next.status;
	// 站点切了就淡入一次，让内容不是硬切；首次渲染不播
	const siteChanged = lastSiteId !== null && lastSiteId !== next.activeSiteId;
	const previousSiteCount = state ? state.sites.length : 0;
	lastSiteId = next.activeSiteId;
	if (siteChanged) {
		// 切了站点，旧站点没到家的改名确认不用再追
		pendingRename = null;
		hintedKey = "";
		pendingUrl = "";
		pendingKey = "";
		ui.apiKey.value = "";
	}
	state = next;
	reconcilePending(next);

	// 只有真正建成了才退出「新增中」；失败就留着，
	// 否则会把上一个站点的「已保存 xxx」又顶回来
	if (previousStatus === "scanning" && next.status === "ready") {
		addingNew = false;
	}
	// 草稿站点已经建下去了（列表多了一条）：从此它就是个正常站点
	if (addingNew && next.sites.length > previousSiteCount) {
		addingNew = false;
		draftRequested = false;
	}

	ui.enabled.checked = next.enabled;
	// 新增态下表单归用户所有：后端推来的仍是上一个站点的值，一回填就把刚填的冲掉了
	if (!addingNew && document.activeElement !== ui.siteName) {
		ui.siteName.value = next.siteName || "";
	}
	// 出错说明这次没存上，别把等待中的确认晾着
	if (next.status === "error") {
		pendingUrl = "";
		pendingKey = "";
	}
	// 改名等后端点头：站点名真的变成我们要的那个才算数，这时才提示
	if (pendingRename !== null) {
		const expected = pendingRename || hostOfUrl(next.baseUrl);
		if (next.siteName === expected) {
			toast(`站点已改名为「${next.siteName}」。`);
			pendingRename = null;
		}
	}
	// 地址和 Key 是失焦就写的，回包到了就是存好了
	if (pendingUrl) {
		if ((next.baseUrl || "").replace(/\/+$/, "") === pendingUrl) {
			toast("地址已保存");
			pendingUrl = "";
		}
	}
	if (pendingKey && next.hasApiKey) {
		toast("Key 已保存");
		pendingKey = "";
	}
	ui.siteNameHint.textContent = addingNew
		? "新站点的名字，留空就用域名。"
		: "只是备注，用来区分多个中转站。";
	if (!addingNew && document.activeElement !== ui.baseUrl) {
		ui.baseUrl.value = next.baseUrl || "";
	}
	ui.subtitleText.textContent = next.thinkingSupported
		? "把中转站模型接进 Copilot 之中"
		: "把中转站模型接进 Copilot 之中（当前版本不显示思考过程）";
	ui.version.textContent = next.version ? `v${next.version}` : "";

	ui.apiKey.placeholder = !addingNew && next.hasApiKey ? `已保存 ${next.apiKeyHint}` : "sk-...";
	ui.keyHint.textContent = addingNew
		? "新站点的密钥会单独保存。"
		: next.hasApiKey
			? `当前密钥：${next.apiKeyHint}，重新填写可覆盖。`
			: DEFAULT_KEY_HINT;
	ui.urlHint.textContent = addingNew
		? "填新中转站的地址，连接后会自动建一个站点。"
		: DEFAULT_URL_HINT;

	const scanning = next.status === "scanning";
	ui.connect.disabled = scanning;
	ui.connect.textContent = scanning ? "读取中…" : addingNew ? "添加并读取模型" : "连接并读取模型";
	// 刷新扫的是当前已存站点，新增态下没有对象可扫
	ui.rescan.disabled = scanning || addingNew || !next.baseUrl;
	// 新增态下列表属于「还不存在的站点」，别把上一站点的模型摆在这里
	const shownModels = addingNew ? [] : next.models;
	ui.selectAll.disabled = scanning || shownModels.length === 0;
	ui.selectNone.disabled = scanning || shownModels.length === 0;

	let badgeText = "未配置";
	let badgeClass = "";
	// 新增态下没有「当前站点」可言，这些数字也别拿上一站点的凑
	const enabledCount = shownModels.filter((model) => model.enabled !== false).length;
	if (next.status === "error") {
		badgeText = "出错";
		badgeClass = "error";
	} else if (scanning) {
		badgeText = "读取中";
	} else if (!next.enabled) {
		badgeText = "已关闭";
	} else if (next.hasApiKey && enabledCount > 0) {
		badgeText = "已注入 Copilot";
		badgeClass = "on";
	} else if (next.hasApiKey) {
		badgeText = "待读取";
	}
	ui.badge.textContent = badgeText;
	ui.badge.className = `badge ${badgeClass}`.trim();

	const meta = [];
	if (shownModels.length > 0) {
		meta.push(`${enabledCount}/${shownModels.length} 启用`);
	}
	if (!addingNew && next.lastScanAt) {
		meta.push(`读取于 ${formatTime(next.lastScanAt)}`);
	}
	ui.meta.textContent = meta.join(" · ");

	// 后端给的说明只在变化时弹一下，不常驻占版面
	if (next.message && next.message !== lastMessage) {
		lastMessage = next.message;
		toast(next.message, next.status === "error" ? "error" : "info");
	}

	const scroller = document.scrollingElement;
	const scrollTop = scroller ? scroller.scrollTop : 0;
	renderSites(next.sites, next.activeSiteId);
	refreshSelectText();
	renderModels(shownModels);
	if (siteChanged) {
		playSiteSwap();
	}
	if (scroller) {
		scroller.scrollTop = scrollTop;
	}
}

ui.connect.addEventListener("click", () => {
	const baseUrl = ui.baseUrl.value.trim();
	if (!baseUrl) {
		ui.baseUrl.focus();
		toast("先填一下中转站地址", "error");
		return;
	}
	ui.connect.disabled = true;
	ui.connect.textContent = "读取中…";
	// 同一个结果再来一次也要弹提示，所以先清掉去重标记
	lastMessage = "";
	send({
		type: "connect",
		baseUrl,
		apiKey: ui.apiKey.value.trim(),
		siteName: ui.siteName.value.trim(),
		// 告诉后端这是「新增」：地址和当前站点一样也要建新站点
		asNew: addingNew,
	});
});

// 改名不用重扫模型：失焦或回车就单独发一条消息
function commitSiteName() {
	if (!state) {
		return;
	}
	const name = ui.siteName.value.trim();
	if (addingNew) {
		// 新增态下名字一改，已能成站（地址有效）就先把站点建出来
		const url = ui.baseUrl.value.trim().replace(/\/+$/, "");
		if (!name || !url || draftRequested || !/^https?:\/\//i.test(url)) {
			return;
		}
		draftRequested = true;
		send({
			type: "saveDraftSite",
			baseUrl: url,
			apiKey: ui.apiKey.value.trim(),
			siteName: name,
		});
		return;
	}
	if (!state.activeSiteId || name === (state.siteName || "")) {
		return;
	}
	// 记下要改成什么，后端确认后再提示
	pendingRename = name;
	send({ type: "renameSite", siteId: state.activeSiteId, name });
}

ui.siteName.addEventListener("blur", commitSiteName);

/** 地址改了直接存，不重扫；模型列表要等下次连接才刷新。 */
function commitSiteUrl() {
	if (!state) {
		return;
	}
	const url = ui.baseUrl.value.trim().replace(/\/+$/, "");
	if (addingNew) {
		// 新增态：地址一填好就把站点建出来，不用等读取成功
		if (!url || draftRequested || !/^https?:\/\//i.test(url)) {
			return;
		}
		draftRequested = true;
		send({
			type: "saveDraftSite",
			baseUrl: url,
			apiKey: ui.apiKey.value.trim(),
			siteName: ui.siteName.value.trim(),
		});
		return;
	}
	const current = (state.baseUrl || "").replace(/\/+$/, "");
	if (!url || url === current) {
		return;
	}
	pendingUrl = url;
	send({ type: "saveSiteFields", baseUrl: url });
}

/** Key 同样一失焦就写进密钥库；新增态下则顺带把站点建出来。 */
function commitSiteKey() {
	if (!state) {
		return;
	}
	// 点「显示/隐藏」只是切明文，不算修改
	if (document.activeElement === ui.toggleKey) {
		return;
	}
	const key = ui.apiKey.value.trim();
	if (!key) {
		return;
	}
	if (addingNew) {
		const url = ui.baseUrl.value.trim().replace(/\/+$/, "");
		if (!url || draftRequested || !/^https?:\/\//i.test(url)) {
			return;
		}
		draftRequested = true;
		send({
			type: "saveDraftSite",
			baseUrl: url,
			apiKey: key,
			siteName: ui.siteName.value.trim(),
		});
		return;
	}
	if (key === hintedKey) {
		return;
	}
	hintedKey = key;
	pendingKey = key;
	send({ type: "saveSiteFields", apiKey: key });
}

ui.baseUrl.addEventListener("blur", commitSiteUrl);
ui.apiKey.addEventListener("blur", () => window.setTimeout(commitSiteKey, 0));
ui.siteName.addEventListener("input", refreshSelectText);
ui.baseUrl.addEventListener("input", refreshSelectText);
ui.siteName.addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault();
		ui.siteName.blur();
	}
});

ui.newSite.addEventListener("click", () => {
	addingNew = true;
	draftRequested = false;
	ui.siteName.value = "";
	ui.baseUrl.value = "";
	ui.apiKey.value = "";
	ui.baseUrl.focus();
	ui.connect.textContent = "添加并读取模型";
	ui.siteNameHint.textContent = "新站点的名字，留空就用域名。";
	ui.urlHint.textContent = "填新中转站的地址，一填好就会先存成一个站点。";
	ui.keyHint.textContent = "新站点的密钥会单独保存。";
	ui.apiKey.placeholder = "sk-...";
	// 立刻把下拉换成草稿项，不等后端推状态，点下去就能看见
	renderSites(state?.sites ?? [], state?.activeSiteId ?? "");
	refreshSelectText();
	// 上一站点的模型不属于这个还没建的站点，直接清掉，别留着误导
	if (state) {
		state.models = [];
		lastModelsKey = "";
	}
	renderModels([]);
	ui.meta.textContent = "";
	// 进入新建态时淡入一次，跟切站点用同一套过渡
	playSiteSwap();
	toast("填好地址和 Key，点下面的按钮就会读取这个新站点的模型");
});

ui.rescan.addEventListener("click", () => {
	lastMessage = "";
	send({ type: "rescan" });
});

ui.enabled.addEventListener("change", () =>
	send({ type: "setEnabled", enabled: ui.enabled.checked })
);

ui.siteSelect.addEventListener("change", () => {
	// 还停在新站点占位项上，不算切换
	if (addingNew && ui.siteSelect.value === "") {
		return;
	}
	addingNew = false;
	send({ type: "selectSite", siteId: ui.siteSelect.value });
});

ui.removeSite.addEventListener("click", () => {
	if (ui.siteSelect.value) {
		send({ type: "removeSite", siteId: ui.siteSelect.value });
	}
});

ui.toggleSite.addEventListener("click", () => {
	const siteId = ui.siteSelect.value;
	const site = (state?.sites ?? []).find((item) => item.id === siteId);
	if (!site) {
		return;
	}
	// 按钮文案是“当前状态的反面”：显示“停用”就发 false
	send({ type: "setSiteEnabled", siteId, enabled: site.enabled === false });
});

ui.search.addEventListener("input", () => {
	keyword = ui.search.value.trim();
	if (state) {
		renderModels(state.models);
	}
});

ui.selectAll.addEventListener("click", () => {
	applyLocalAll(true);
});

ui.selectNone.addEventListener("click", () => {
	applyLocalAll(false);
});

ui.toggleKey.addEventListener("click", () => {
	const showing = ui.apiKey.type === "text";
	ui.apiKey.type = showing ? "password" : "text";
	ui.toggleKey.textContent = showing ? "显示" : "隐藏";
});

ui.openSettings.addEventListener("click", () => send({ type: "openSettings" }));
ui.wipeAll.addEventListener("click", () => {
	// 结果提示走后端推回的 message，先清掉去重标记保证会弹
	lastMessage = "";
	// 数据要全没了，之前没等到回执的勾选也没必要再去追
	pendingToggles.clear();
	pendingAll = null;
	send({ type: "wipeAll" });
});
ui.openSettings.addEventListener("click", () => send({ type: "openSettings" }));

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message && message.type === "state") {
		render(message.state);
	}
});

send({ type: "ready" });
