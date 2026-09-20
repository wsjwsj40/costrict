import { z } from "zod"

import type { UpdateManifest } from "./types"

const updateManifestSchema = z.object({
	version: z.string().min(1),
	minimumVersion: z.string().min(1).optional(),
	mandatory: z.boolean().optional(),
	releaseNotes: z.string().max(20_000).optional(),
	sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
	publishedAt: z.string().datetime({ offset: true }).optional(),
})

export function parseUpdateManifest(value: unknown): UpdateManifest {
	return updateManifestSchema.parse(value)
}

export function validateUpdateUrls(manifestUrl: string, downloadUrl: string, allowInsecureHttp: boolean): void {
	const manifest = new URL(manifestUrl)
	const download = new URL(downloadUrl, manifest)
	const allowedProtocols = allowInsecureHttp ? ["https:", "http:"] : ["https:"]

	if (!allowedProtocols.includes(manifest.protocol) || !allowedProtocols.includes(download.protocol)) {
		throw new Error("Update URLs must use HTTPS unless insecure HTTP is explicitly enabled")
	}
	if (manifest.origin !== download.origin) {
		throw new Error("The update package must be hosted on the same origin as the update manifest")
	}
}
