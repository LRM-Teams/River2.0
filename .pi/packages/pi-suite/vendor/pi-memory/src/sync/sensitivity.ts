const SECRET_PATTERNS: RegExp[] = [
	/\b(?:api[_-]?key|token|secret|password|passwd|authorization|cookie)\b\s*[:=]\s*[^\s]+/i,
	/\b(?:sk|pk|ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/,
	/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3,}\b/,
	/\b\d{6}\b.*\b(?:otp|2fa|mfa|code)\b/i,
];

export function detectSensitivity(text: string): "none" | "local_path" | "secret" {
	if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return "secret";
	if (/\/(?:home|Users|workspaces)\/[\w.-]+\//.test(text) || /[A-Za-z]:\\Users\\[^\\]+\\/.test(text)) return "local_path";
	return "none";
}

export function redactLocalPaths(text: string): string {
	return text
		.replace(/\/(?:home|Users|workspaces)\/[\w.-]+\//g, "~/")
		.replace(/[A-Za-z]:\\Users\\[^\\]+\\/g, "<user-home>\\");
}
