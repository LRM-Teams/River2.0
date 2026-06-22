export class LspToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspToolError";
	}
}

export class LspAbortError extends Error {
	constructor() {
		super("Operation aborted");
		this.name = "LspAbortError";
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new LspAbortError();
	}
}

export function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
	return err instanceof LspAbortError || signal?.aborted === true;
}
