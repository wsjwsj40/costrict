import * as vscode from "vscode"

import { readImageAsDataUrlWithBuffer } from "../../../core/tools/helpers/imageHelpers"
import { selectImages } from "../process-images"

vi.mock("vscode", () => ({
	window: { showOpenDialog: vi.fn() },
}))

vi.mock("../../../core/tools/helpers/imageHelpers", () => ({
	readImageAsDataUrlWithBuffer: vi.fn(),
}))

describe("selectImages", () => {
	it("allows SVG selection and sends its PNG conversion", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: "/workspace/diagram.svg" }] as any)
		vi.mocked(readImageAsDataUrlWithBuffer).mockResolvedValue({
			dataUrl: "data:image/png;base64,converted",
			buffer: Buffer.from("png"),
		})

		await expect(selectImages()).resolves.toEqual(["data:image/png;base64,converted"])
		expect(vscode.window.showOpenDialog).toHaveBeenCalledWith(
			expect.objectContaining({ filters: { Images: expect.arrayContaining(["svg"]) } }),
		)
		expect(readImageAsDataUrlWithBuffer).toHaveBeenCalledWith("/workspace/diagram.svg")
	})
})
