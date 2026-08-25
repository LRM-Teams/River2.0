/**
 * media-tools: vision/audio + ffmpeg helpers for benchmark tasks.
 *
 * - gemini_vision: ask Gemini (via Zhizengzeng's Google-native gateway) about images,
 *   videos, or audio. Videos are sent whole (audio track included, native 1fps sampling,
 *   timestamp-aware). Oversized videos are transcoded down; frame sampling is the last
 *   resort. Optional smart-crop mode zooms into the relevant image region automatically.
 * - video_frames: extract frames from a video to files (interval / timestamps / scene).
 * - image_crop: crop and/or resize an image with ffmpeg.
 * - media_probe: ffprobe metadata summary (duration, streams, resolution).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// User-level config; never shipped inside the npm package.
const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "media-tools.json");
const DEFAULT_BASE_URL = "https://api.zhizengzeng.com";
const DEFAULT_VISION_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 65_000;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 2;
// Gemini inline payload budget is 20MB; leave headroom for base64 + JSON overhead.
const INLINE_BUDGET_BYTES = 13 * 1024 * 1024;

const IMAGE_MIMES: Record<string, string> = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
};
const VIDEO_MIMES: Record<string, string> = {
	".mp4": "video/mp4", ".mpeg": "video/mpeg", ".mpg": "video/mpg",
	".mov": "video/mov", ".avi": "video/avi", ".flv": "video/x-flv",
	".webm": "video/webm", ".wmv": "video/wmv", ".3gp": "video/3gpp", ".m4v": "video/mp4",
	".mkv": "video/mp4",
};
const AUDIO_MIMES: Record<string, string> = {
	".mp3": "audio/mp3", ".wav": "audio/wav", ".aac": "audio/aac",
	".ogg": "audio/ogg", ".flac": "audio/flac", ".m4a": "audio/aac", ".aiff": "audio/aiff",
};

type Config = { apiKey?: string; baseUrl?: string; visionModel?: string; requestTimeoutMs?: number };
type NativePart = { text?: string; inline_data?: { mime_type: string; data: string } };

class GeminiGatewayError extends Error {
	retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "GeminiGatewayError";
		this.retryable = retryable;
	}
}

export function retryDelayMs(attempt: number, randomValue = Math.random()): number {
	return Math.min(2_000, 400 * 2 ** attempt) + Math.floor(Math.max(0, Math.min(1, randomValue)) * 200);
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error("aborted");
	await new Promise<void>((resolve, reject) => {
		const finish = (): void => {
			if (signal) signal.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(finish, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			if (signal) signal.removeEventListener("abort", abort);
			reject(new Error("aborted"));
		};
		if (signal) signal.addEventListener("abort", abort, { once: true });
	});
}

async function loadConfig(): Promise<Config> {
	try {
		return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")) as Config;
	} catch {
		return {};
	}
}

function resolvePath(ctx: ExtensionContext, p: string): string {
	return path.isAbsolute(p) ? p : path.join(ctx.cwd, p);
}

async function requireNewOutput(file: string): Promise<void> {
	try {
		await fs.access(file);
		throw new Error(`Refusing to overwrite existing output: ${file}. Choose a distinct output path.`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

async function ffprobeJson(file: string): Promise<Record<string, unknown>> {
	const { stdout } = await execFileAsync("ffprobe", [
		"-v", "error",
		"-print_format", "json",
		"-show_format", "-show_streams",
		file,
	], { maxBuffer: 8 * 1024 * 1024 });
	return JSON.parse(stdout) as Record<string, unknown>;
}

async function videoDurationSeconds(file: string): Promise<number> {
	const probe = await ffprobeJson(file);
	const fmt = probe.format as { duration?: string } | undefined;
	const dur = Number(fmt?.duration ?? 0);
	if (!Number.isFinite(dur) || dur <= 0) throw new Error(`Cannot determine duration of ${file}`);
	return dur;
}

async function imageDimensions(file: string): Promise<{ width: number; height: number }> {
	const probe = await ffprobeJson(file);
	const stream = ((probe.streams as Array<{ width?: number; height?: number }>) || []).find((s) => s.width && s.height);
	if (!stream?.width || !stream?.height) throw new Error(`Cannot determine dimensions of ${file}`);
	return { width: stream.width, height: stream.height };
}

async function extractFrameAt(file: string, seconds: number, outPath: string, maxWidth: number): Promise<void> {
	await execFileAsync("ffmpeg", [
		"-y", "-loglevel", "error",
		"-ss", seconds.toFixed(3),
		"-i", file,
		"-frames:v", "1",
		"-vf", `scale='min(${maxWidth},iw)':-2`,
		"-q:v", "3",
		outPath,
	], { maxBuffer: 8 * 1024 * 1024 });
}

function fmtTs(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = (seconds % 60).toFixed(1);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.padStart(4, "0")}`;
}

async function callGeminiNative(
	baseUrl: string,
	apiKey: string,
	model: string,
	parts: NativePart[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<string> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (signal?.aborted) throw new Error("aborted");
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const response = await fetch(`${baseUrl}/google/v1beta/models/${model}:generateContent`, {
				method: "POST",
				headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
				body: JSON.stringify({ contents: [{ parts }] }),
				signal: requestSignal,
			});
			const text = await response.text();
			let payload: {
				candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
				error?: { message?: string };
			};
			try {
				payload = JSON.parse(text);
			} catch {
				throw new GeminiGatewayError(
					`Gemini gateway returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
					response.status === 429 || response.status >= 500,
				);
			}
			if (!response.ok || payload.error) {
				throw new GeminiGatewayError(
					`Gemini request failed (${response.status}): ${payload.error?.message || text.slice(0, 300)}`,
					response.status === 429 || response.status >= 500,
				);
			}
			const answer = (payload.candidates?.[0]?.content?.parts || [])
				.filter((p) => p.text && p.thought !== true)
				.map((p) => p.text)
				.join("\n")
				.trim();
			if (!answer) throw new Error("Gemini returned an empty answer.");
			return answer;
		} catch (error) {
			if (signal?.aborted) throw new Error("aborted");
			lastError = error instanceof GeminiGatewayError
				? error
				: new GeminiGatewayError(error instanceof Error ? error.message : String(error), true);
			if (attempt > 0 || !lastError.retryable) throw lastError;
			await waitForRetry(retryDelayMs(attempt), signal);
		}
	}
	throw lastError ?? new Error("Gemini request failed.");
}

const SMART_CROP_PROMPT = (question: string) => `Please observe this image. The user's question is: ${question}

Please note:
If answering requires most of the image, answer the question directly based on the image.
If only a small region of the image is needed to answer, you must return that region's coordinates instead of answering!
Return only the target region's normalized coordinates in the range 0-1000 as: {"2dpos":[y0, x0, y1, x1]}. No markdown.`;

const VisionParams = Type.Object({
	paths: Type.Array(Type.String(), {
		description: "Media files to analyze: images (.png/.jpg/...), videos (.mp4/.mov/...), or audio (.mp3/.wav/...). Absolute or cwd-relative paths.",
	}),
	question: Type.String({ description: "What to find out. For videos you can reference timestamps in MM:SS form; the model sees the full video with its audio track." }),
	startSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Clip a video/audio input: start time in seconds (requires durationSeconds)." })),
	durationSeconds: Type.Optional(Type.Number({ minimum: 0.1, description: "Clip a video/audio input: length in seconds from startSeconds." })),
	smartCrop: Type.Optional(Type.Boolean({ description: "Single-image mode: let the model zoom into the relevant region first (two-pass crop-and-reask) for small details like text or distant objects." })),
	maxFrames: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, description: "Frame cap for the sampling fallback when a video is too large even after transcoding (default 12)." })),
	structured: Type.Optional(Type.Boolean({ description: "Return JSON with answer, candidates, confidence, and evidence. Use when locations, categories, or other ambiguous graded facts need conflict-aware verification." })),
});

const VideoFramesParams = Type.Object({
	path: Type.String({ description: "Video file path." }),
	timestamps: Type.Optional(Type.Array(Type.Number(), { description: "Exact timestamps in seconds to extract." })),
	everySeconds: Type.Optional(Type.Number({ minimum: 0.1, description: "Extract one frame every N seconds." })),
	sceneThreshold: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1, description: "Scene-change detection threshold (e.g. 0.3). Extracts frames at scene cuts." })),
	maxFrames: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Cap on extracted frames (default 40)." })),
	outputDir: Type.Optional(Type.String({ description: "Output directory (default: <video-dir>/frames)." })),
	maxWidth: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096, description: "Downscale frames to this width (default 1280)." })),
});

const CropParams = Type.Object({
	path: Type.String({ description: "Input image path." }),
	x: Type.Integer({ minimum: 0 }),
	y: Type.Integer({ minimum: 0 }),
	width: Type.Integer({ minimum: 1 }),
	height: Type.Integer({ minimum: 1 }),
	output: Type.Optional(Type.String({ description: "Output path (default: <name>-crop.<ext>)." })),
	resizeWidth: Type.Optional(Type.Integer({ minimum: 16, description: "Optionally resize the cropped result to this width (keeps aspect)." })),
});

const ProbeParams = Type.Object({
	path: Type.String({ description: "Media file path (video, audio, or image)." }),
});

const ContactSheetParams = Type.Object({
	paths: Type.Array(Type.String(), { minItems: 1, maxItems: 64, description: "Image paths in stable label order (1..N)." }),
	output: Type.Optional(Type.String({ description: "Output image path (default: contact-sheet.jpg in cwd)." })),
	columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Grid columns (default 5)." })),
	cellWidth: Type.Optional(Type.Integer({ minimum: 64, maximum: 1024, description: "Cell width in pixels (default 256)." })),
	cellHeight: Type.Optional(Type.Integer({ minimum: 64, maximum: 1024, description: "Cell height in pixels (default 256)." })),
});

export function contactSheetLayout(count: number, columns: number, cellWidth: number, cellHeight: number): string {
	return Array.from({ length: count }, (_value, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		return `${column * cellWidth}_${row * cellHeight}`;
	}).join("|");
}

export default function (pi: ExtensionAPI) {
	let consecutiveGatewayFailures = 0;
	let circuitOpenUntil = 0;

	pi.on("session_start", () => {
		consecutiveGatewayFailures = 0;
		circuitOpenUntil = 0;
		pi.appendEntry("pi-suite-extension-health", { extension: "media-tools", status: "active" });
	});

	const callVision = async (
		baseUrl: string,
		apiKey: string,
		model: string,
		parts: NativePart[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<string> => {
		if (Date.now() < circuitOpenUntil) {
			throw new Error(`Gemini circuit breaker is open for ${Math.ceil((circuitOpenUntil - Date.now()) / 1000)}s after repeated gateway failures`);
		}
		try {
			const answer = await callGeminiNative(baseUrl, apiKey, model, parts, timeoutMs, signal);
			consecutiveGatewayFailures = 0;
			return answer;
		} catch (error) {
			if (error instanceof GeminiGatewayError && error.retryable) {
				consecutiveGatewayFailures += 1;
				if (consecutiveGatewayFailures >= CIRCUIT_FAILURE_THRESHOLD) {
					circuitOpenUntil = Date.now() + DEFAULT_CIRCUIT_COOLDOWN_MS;
				}
			}
			throw error;
		}
	};

	pi.registerTool({
		name: "gemini_vision",
		label: "Gemini Vision",
		description:
			"Analyze images, videos, or audio with Gemini and get a text answer back. " +
			"Videos are sent whole through Gemini's native video understanding (audio track included, timestamp-aware); " +
			"oversized videos are automatically transcoded smaller, with frame sampling as last resort. " +
			"Audio files are understood natively (speech, music, sounds). " +
			"Set smartCrop=true on a single image to auto-zoom into the relevant region for fine details.",
		promptSnippet: "Understand images/videos/audio via gemini_vision(paths, question); whole-video + audio-track understanding, text answer back",
		promptGuidelines: [
			"Use gemini_vision to understand image, video, or audio content; you stay in control and get a text answer back.",
			"Videos are analyzed whole with their audio track; reference moments as MM:SS timestamps. One video per call works best.",
			"For very long videos, ask for an overview first, then use startSeconds/durationSeconds to re-inspect key segments, or video_frames to locate cuts.",
			"For small details in images (text, scoreboard, distant objects), set smartCrop=true.",
			"If the answer drives a graded artifact, verify with a second targeted call before writing it down.",
			"For ambiguous locations or categories, set structured=true and compare candidates and evidence; do not let one late call silently replace stronger prior evidence.",
		],
		parameters: VisionParams,
		async execute(_id, params: { paths: string[]; question: string; startSeconds?: number; durationSeconds?: number; smartCrop?: boolean; maxFrames?: number; structured?: boolean }, signal, onUpdate, ctx) {
			const config = await loadConfig();
			const apiKey = process.env.ZHIZENGZENG_API_KEY || config.apiKey;
			if (!apiKey) {
				return { content: [{ type: "text", text: `Missing API key. Set ZHIZENGZENG_API_KEY or ${CONFIG_PATH}.` }], isError: true };
			}
			const baseUrl = (process.env.ZHIZENGZENG_BASE_URL || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
			const model = config.visionModel || DEFAULT_VISION_MODEL;
			const requestTimeoutMs =
				typeof config.requestTimeoutMs === "number" && Number.isFinite(config.requestTimeoutMs)
					? Math.max(5_000, Math.min(45_000, Math.floor(config.requestTimeoutMs)))
					: DEFAULT_REQUEST_TIMEOUT_MS;
			const maxFrames = params.maxFrames ?? 12;
			const toolSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS)])
				: AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS);

			const parts: NativePart[] = [];
			const described: string[] = [];
			let inlineBytes = 0;
			let tmpDir: string | undefined;
			const ensureTmp = async () => (tmpDir ??= await fs.mkdtemp(path.join(ctx.cwd, ".vision-tmp-")));

			try {
				// Smart-crop mode: single image, two-pass zoom.
				if (params.smartCrop) {
					const imgPaths = params.paths.filter((p) => IMAGE_MIMES[path.extname(p).toLowerCase()]);
					if (imgPaths.length !== 1 || params.paths.length !== 1) {
						return { content: [{ type: "text", text: "smartCrop requires exactly one image path." }], isError: true };
					}
					const file = resolvePath(ctx, imgPaths[0]);
					await fs.access(file);
					const mime = IMAGE_MIMES[path.extname(file).toLowerCase()];
					const b64 = (await fs.readFile(file)).toString("base64");
					onUpdate?.({ content: [{ type: "text", text: "Pass 1: locating relevant region..." }] });
					const first = await callVision(baseUrl, apiKey, model, [
						{ inline_data: { mime_type: mime, data: b64 } },
						{ text: SMART_CROP_PROMPT(params.question) },
					], requestTimeoutMs, toolSignal);
					const match = first.match(/\{[^{}]*"2dpos"\s*:\s*\[([^\]]+)\][^{}]*\}/);
					if (!match) {
						return { content: [{ type: "text", text: first }], details: { model, mode: "smartCrop:direct" } };
					}
					const coords = match[1].split(",").map((v) => Number(v.trim()));
					if (coords.length !== 4 || coords.some((v) => !Number.isFinite(v))) {
						return { content: [{ type: "text", text: first }], details: { model, mode: "smartCrop:direct" } };
					}
					const [y0, x0, y1, x1] = coords;
					const { width, height } = await imageDimensions(file);
					const cx = Math.max(0, Math.floor((x0 / 1000) * width));
					const cy = Math.max(0, Math.floor((y0 / 1000) * height));
					const cw = Math.max(1, Math.min(width - cx, Math.ceil(((x1 - x0) / 1000) * width)));
					const ch = Math.max(1, Math.min(height - cy, Math.ceil(((y1 - y0) / 1000) * height)));
					const cropPath = path.join(await ensureTmp(), `zoom${path.extname(file)}`);
					await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", `crop=${cw}:${ch}:${cx}:${cy}`, cropPath], { maxBuffer: 8 * 1024 * 1024 });
					onUpdate?.({ content: [{ type: "text", text: `Pass 2: analyzing zoomed region ${cw}x${ch} at (${cx},${cy})...` }] });
					const cropB64 = (await fs.readFile(cropPath)).toString("base64");
					const second = await callVision(baseUrl, apiKey, model, [
						{ inline_data: { mime_type: mime, data: cropB64 } },
						{ text: `${params.question}\nAnswer precisely based only on what is visible. This is a zoomed-in crop of a larger image.` },
					], requestTimeoutMs, toolSignal);
					return { content: [{ type: "text", text: second }], details: { model, mode: "smartCrop:zoomed", region: { x: cx, y: cy, width: cw, height: ch } } };
				}

				for (const raw of params.paths) {
					let file = resolvePath(ctx, raw);
					await fs.access(file);
					const ext = path.extname(file).toLowerCase();
					const name = path.basename(file);

					if (IMAGE_MIMES[ext]) {
						const data = await fs.readFile(file);
						inlineBytes += data.length;
						parts.push({ text: `Image: ${name}` });
						parts.push({ inline_data: { mime_type: IMAGE_MIMES[ext], data: data.toString("base64") } });
						described.push(`image ${name}`);
						continue;
					}

					const isVideo = Boolean(VIDEO_MIMES[ext]);
					const isAudio = Boolean(AUDIO_MIMES[ext]);
					if (!isVideo && !isAudio) {
						return { content: [{ type: "text", text: `Unsupported media type: ${file}` }], isError: true };
					}

					// Optional clipping (applies to video/audio inputs).
					let clipNote = "";
					if (params.startSeconds !== undefined && params.durationSeconds) {
						const clipPath = path.join(await ensureTmp(), `clip-${name}`);
						await execFileAsync("ffmpeg", [
							"-y", "-loglevel", "error",
							"-ss", String(params.startSeconds),
							"-t", String(params.durationSeconds),
							"-i", file,
							"-c", "copy",
							clipPath,
						], { maxBuffer: 8 * 1024 * 1024 });
						file = clipPath;
						clipNote = ` (clip ${fmtTs(params.startSeconds)} + ${params.durationSeconds}s)`;
					}

					let size = (await fs.stat(file)).size;
					let mime = isVideo ? (VIDEO_MIMES[ext] as string) : (AUDIO_MIMES[ext] as string);

					// Too big for inline: transcode down (video) or re-encode (audio).
					if (size + inlineBytes > INLINE_BUDGET_BYTES) {
						const smallPath = path.join(await ensureTmp(), isVideo ? "small.mp4" : "small.mp3");
						onUpdate?.({ content: [{ type: "text", text: `${name} is ${(size / 1e6).toFixed(1)}MB; transcoding down for inline analysis...` }] });
						if (isVideo) {
							await execFileAsync("ffmpeg", [
								"-y", "-loglevel", "error", "-i", file,
								"-vf", "scale='min(640,iw)':-2", "-r", "5",
								"-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
								"-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart",
								smallPath,
							], { maxBuffer: 16 * 1024 * 1024 });
							mime = "video/mp4";
						} else {
							await execFileAsync("ffmpeg", [
								"-y", "-loglevel", "error", "-i", file,
								"-c:a", "libmp3lame", "-b:a", "48k", "-ac", "1",
								smallPath,
							], { maxBuffer: 16 * 1024 * 1024 });
							mime = "audio/mp3";
						}
						const smallSize = (await fs.stat(smallPath)).size;
						if (smallSize + inlineBytes <= INLINE_BUDGET_BYTES) {
							file = smallPath;
							size = smallSize;
						} else if (isVideo) {
							// Last resort: sampled frames with timestamps.
							const duration = await videoDurationSeconds(file);
							const n = Math.min(maxFrames, Math.max(4, Math.ceil(duration / 10)));
							onUpdate?.({ content: [{ type: "text", text: `Still too large; falling back to ${n} sampled frames.` }] });
							parts.push({ text: `Video: ${name}${clipNote}, duration ${fmtTs(duration)}. Too large to inline; ${n} sampled frames follow, labeled with timestamps. The audio track is NOT included.` });
							for (let i = 0; i < n; i++) {
								if (toolSignal.aborted) throw new Error("aborted");
								const t = (duration * (i + 0.5)) / n;
								const framePath = path.join(await ensureTmp(), `f${i}.jpg`);
								await extractFrameAt(file, t, framePath, 1024);
								const b64 = (await fs.readFile(framePath)).toString("base64");
								parts.push({ text: `Frame at ${fmtTs(t)}:` });
								parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
							}
							described.push(`video ${name} (${n} frames, no audio)`);
							continue;
						} else {
							return { content: [{ type: "text", text: `${name} is too large even after re-encoding (${(smallSize / 1e6).toFixed(1)}MB). Use startSeconds/durationSeconds to clip a segment.` }], isError: true };
						}
					}

					inlineBytes += size;
					parts.push({ text: `${isVideo ? "Video" : "Audio"}: ${name}${clipNote}` });
					parts.push({ inline_data: { mime_type: mime, data: (await fs.readFile(file)).toString("base64") } });
					described.push(`${isVideo ? "video" : "audio"} ${name}${clipNote}`);
				}

				parts.push({ text: `Question: ${params.question}\nAnswer precisely based only on what is visible/audible. Use MM:SS format for timestamps. If something cannot be determined from the provided media, say so explicitly instead of guessing.${params.structured ? '\nReturn only valid JSON with this shape: {"answer":"...","candidates":[{"name":"...","confidence":0.0,"evidence":["..."]}],"confidence":0.0,"evidence":["..."]}. Confidence must be between 0 and 1.' : ""}` });

				onUpdate?.({ content: [{ type: "text", text: `Asking ${model} about ${described.join(", ")}...` }] });
				const answer = await callVision(baseUrl, apiKey, model, parts, requestTimeoutMs, toolSignal);
				return { content: [{ type: "text", text: answer }], details: { model, media: described, structured: params.structured === true } };
			} catch (error) {
				return { content: [{ type: "text", text: `gemini_vision failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
			} finally {
				if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			}
		},
	});

	pi.registerTool({
		name: "image_contact_sheet",
		label: "Image Contact Sheet",
		description: "Create a numbered contact sheet from up to 64 images using ffmpeg. Returns the output path and the stable number-to-file mapping for batch visual classification.",
		promptSnippet: "Create a numbered image grid with image_contact_sheet before classifying many images.",
		promptGuidelines: [
			"For directories of images, build a contact sheet and inspect pixels in batches; never classify only from filenames.",
		],
		parameters: ContactSheetParams,
		async execute(_id, params: { paths: string[]; output?: string; columns?: number; cellWidth?: number; cellHeight?: number }, signal, _onUpdate, ctx) {
			const files = params.paths.map((candidate) => resolvePath(ctx, candidate));
			for (const file of files) {
				if (signal?.aborted) throw new Error("aborted");
				await fs.access(file);
				if (!IMAGE_MIMES[path.extname(file).toLowerCase()]) throw new Error(`Unsupported image type: ${file}`);
			}
			const columns = Math.min(params.columns ?? 5, files.length);
			const cellWidth = params.cellWidth ?? 256;
			const cellHeight = params.cellHeight ?? 256;
			const output = resolvePath(ctx, params.output ?? "contact-sheet.jpg");
			await requireNewOutput(output);
			await fs.mkdir(path.dirname(output), { recursive: true });
			const args = ["-y", "-loglevel", "error"];
			for (const file of files) args.push("-i", file);
			const filters = files.map((_file, index) =>
				`[${index}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2:color=white,drawtext=text='${index + 1}':x=8:y=8:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.65[v${index}]`,
			);
			if (files.length === 1) {
				filters.push("[v0]null[out]");
			} else {
				filters.push(`${files.map((_file, index) => `[v${index}]`).join("")}xstack=inputs=${files.length}:layout=${contactSheetLayout(files.length, columns, cellWidth, cellHeight)}:fill=white[out]`);
			}
			args.push("-filter_complex", filters.join(";"), "-map", "[out]", "-frames:v", "1", "-q:v", "2", output);
			await execFileAsync("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024, signal });
			const mapping = files.map((file, index) => ({ label: index + 1, path: file }));
			return {
				content: [{ type: "text", text: `Contact sheet: ${output}\n${mapping.map((entry) => `${entry.label}: ${entry.path}`).join("\n")}` }],
				details: { output, columns, cellWidth, cellHeight, mapping },
			};
		},
	});

	pi.registerTool({
		name: "video_frames",
		label: "Video Frames",
		description:
			"Extract frames from a video to image files using ffmpeg. Supports fixed intervals, exact timestamps, or scene-change detection. " +
			"Returns the written file paths with their timestamps.",
		promptSnippet: "Extract video keyframes to files with video_frames (interval / timestamps / scene detection)",
		promptGuidelines: [
			"Use video_frames when you need frame images on disk (for clips, posters, or to inspect specific moments), and scene detection to locate cuts/highlights.",
		],
		parameters: VideoFramesParams,
		async execute(_id, params: { path: string; timestamps?: number[]; everySeconds?: number; sceneThreshold?: number; maxFrames?: number; outputDir?: string; maxWidth?: number }, signal, onUpdate, ctx) {
			const file = resolvePath(ctx, params.path);
			await fs.access(file);
			const maxFrames = params.maxFrames ?? 40;
			const maxWidth = params.maxWidth ?? 1280;
			const outDir = resolvePath(ctx, params.outputDir || path.join(path.dirname(file), "frames"));
			await fs.mkdir(outDir, { recursive: true });
			const stem = path.basename(file, path.extname(file));

			let timestamps: number[];
			if (params.timestamps?.length) {
				timestamps = params.timestamps.slice(0, maxFrames);
			} else if (params.sceneThreshold) {
				const { stderr } = await execFileAsync("ffmpeg", [
					"-loglevel", "info",
					"-i", file,
					"-vf", `select='gt(scene,${params.sceneThreshold})',showinfo`,
					"-f", "null", "-",
				], { maxBuffer: 32 * 1024 * 1024 });
				timestamps = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).slice(0, maxFrames);
				if (timestamps.length === 0) {
					return { content: [{ type: "text", text: `No scene changes above threshold ${params.sceneThreshold}. Try a lower threshold or everySeconds sampling.` }] };
				}
			} else {
				const duration = await videoDurationSeconds(file);
				const step = params.everySeconds ?? Math.max(1, duration / maxFrames);
				timestamps = [];
				for (let t = 0; t < duration && timestamps.length < maxFrames; t += step) timestamps.push(t);
			}

			const planned = timestamps.map((timestamp, index) => ({
				path: path.join(outDir, `${stem}-${String(index).padStart(3, "0")}-${timestamp.toFixed(1)}s.jpg`),
				timestamp,
			}));
			for (const output of planned) await requireNewOutput(output.path);
			const written: Array<{ path: string; timestamp: number }> = [];
			for (const [i, output] of planned.entries()) {
				if (signal?.aborted) break;
				await extractFrameAt(file, output.timestamp, output.path, maxWidth);
				written.push(output);
				if (i % 10 === 9) onUpdate?.({ content: [{ type: "text", text: `Extracted ${i + 1}/${planned.length} frames...` }] });
			}

			const lines = [`Extracted ${written.length} frame(s) from ${file}:`, ...written.map((w) => `- [${fmtTs(w.timestamp)}] ${w.path}`)];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { outputDir: outDir, frames: written } };
		},
	});

	pi.registerTool({
		name: "image_crop",
		label: "Image Crop",
		description: "Crop a rectangular region out of an image (and optionally resize it) using ffmpeg. Returns the output file path.",
		promptSnippet: "Crop/resize images with image_crop(path, x, y, width, height)",
		parameters: CropParams,
		async execute(_id, params: { path: string; x: number; y: number; width: number; height: number; output?: string; resizeWidth?: number }, _signal, _onUpdate, ctx) {
			const file = resolvePath(ctx, params.path);
			await fs.access(file);
			const ext = path.extname(file) || ".png";
			const outPath = resolvePath(ctx, params.output || path.join(path.dirname(file), `${path.basename(file, ext)}-crop${ext}`));
			await requireNewOutput(outPath);
			await fs.mkdir(path.dirname(outPath), { recursive: true });
			let vf = `crop=${params.width}:${params.height}:${params.x}:${params.y}`;
			if (params.resizeWidth) vf += `,scale=${params.resizeWidth}:-2`;
			await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", vf, outPath], { maxBuffer: 8 * 1024 * 1024 });
			return { content: [{ type: "text", text: `Cropped ${file} -> ${outPath} (${params.width}x${params.height} at ${params.x},${params.y}${params.resizeWidth ? `, resized to width ${params.resizeWidth}` : ""})` }], details: { output: outPath } };
		},
	});

	pi.registerTool({
		name: "media_probe",
		label: "Media Probe",
		description: "Inspect a media file with ffprobe: duration, resolution, codecs, fps, streams. Use before extracting frames or clips.",
		promptSnippet: "Inspect media metadata (duration/resolution/codec) with media_probe",
		parameters: ProbeParams,
		async execute(_id, params: { path: string }, _signal, _onUpdate, ctx) {
			const file = resolvePath(ctx, params.path);
			await fs.access(file);
			const probe = await ffprobeJson(file);
			const fmt = probe.format as Record<string, unknown> | undefined;
			const streams = (probe.streams as Array<Record<string, unknown>>) || [];
			const lines = [
				`File: ${file}`,
				`Format: ${fmt?.format_name ?? "?"}, duration: ${fmt?.duration ?? "?"}s, size: ${fmt?.size ?? "?"} bytes, bitrate: ${fmt?.bit_rate ?? "?"}`,
				...streams.map((s, i) =>
					`Stream ${i}: ${s.codec_type}/${s.codec_name}` +
					(s.width ? `, ${s.width}x${s.height}` : "") +
					(s.avg_frame_rate && s.avg_frame_rate !== "0/0" ? `, fps=${s.avg_frame_rate}` : "") +
					(s.sample_rate ? `, ${s.sample_rate}Hz ch=${s.channels}` : ""),
				),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: probe };
		},
	});
}
