import fs from "fs/promises"
import os from "os"
import path from "path"

import { readImageAsDataUrlWithBuffer } from "../imageHelpers"

describe("SVG image conversion", () => {
	it("returns PNG image data for a local SVG", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dicode-svg-"))
		try {
			const svgPath = path.join(directory, "diagram.svg")
			await fs.writeFile(
				svgPath,
				'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
			)

			const { dataUrl, buffer } = await readImageAsDataUrlWithBuffer(svgPath)
			expect(dataUrl).toBe(`data:image/png;base64,${buffer.toString("base64")}`)
			expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
})
