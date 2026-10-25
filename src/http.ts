/**
 * HTTP 公共层：超时、重试、SSE / NDJSON 行解析。
 * 所有协议共用，避免各写一套。
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 800;

export interface FetchOptions {
	url: string;
	init: RequestInit;
	/** 首次响应超时（毫秒）。 */
	timeoutMs?: number;
	/** 传入后由调用方控制取消。 */
	signal?: AbortSignal;
	/** 是否对 429/5xx 做退避重试。 */
	retry?: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("请求已取消"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function fetchWithRetry(options: FetchOptions): Promise<Response> {
	const attempts = options.retry === false ? 1 : MAX_ATTEMPTS;
	let lastError: unknown;

	for (let attempt = 0; attempt < attempts; attempt++) {
		const controller = new AbortController();
		const forwardAbort = () => controller.abort();
		options.signal?.addEventListener("abort", forwardAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

		try {
			const response = await fetch(options.url, { ...options.init, signal: controller.signal });
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", forwardAbort);

			if (RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
				const retryAfter = Number(response.headers.get("retry-after"));
				const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** attempt;
				await sleep(Math.min(wait, 10_000), options.signal);
				continue;
			}
			return response;
		} catch (error) {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", forwardAbort);
			if (options.signal?.aborted) {
				throw new Error("请求已取消");
			}
			lastError = error;
			if (attempt < attempts - 1) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, options.signal);
				continue;
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error("请求失败");
}

/** 逐行读取响应体（SSE 与 NDJSON 都能用）。 */
export async function readLines(
	body: ReadableStream<Uint8Array>,
	onLine: (line: string) => void
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				onLine(line.trim());
			}
		}
		if (buffer.trim()) {
			onLine(buffer.trim());
		}
	} finally {
		reader.releaseLock();
	}
}

/** 从 `data: {...}` 行里取出 JSON；不是数据行返回 undefined。 */
export function parseSseData(line: string): Record<string, unknown> | undefined {
	if (!line.startsWith("data:")) {
		return undefined;
	}
	const payload = line.slice(5).trim();
	if (!payload || payload === "[DONE]") {
		return undefined;
	}
	try {
		const value = JSON.parse(payload);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function errorFromResponse(status: number, statusText: string, body: string): Error {
	const detail = body.trim().slice(0, 400);
	return new Error(`上游返回 ${status} ${statusText}${detail ? `：${detail}` : ""}`);
}
