export interface UpdateManifest {
	version: string
	minimumVersion?: string
	mandatory?: boolean
	releaseNotes?: string
	sha256: string
	publishedAt?: string
}

export interface UpdateCheckResult {
	manifest: UpdateManifest
	mandatory: boolean
}
