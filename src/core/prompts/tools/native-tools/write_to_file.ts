import type OpenAI from "openai"

const WRITE_TO_FILE_DESCRIPTION = `Request to write content to a file. By default, if the file exists it will be overwritten; if it doesn't exist it will be created. This tool will automatically create any directories needed to write the file.

**Important:** You should prefer using other editing tools over write_to_file when making changes to existing files, since write_to_file is slower and cannot handle large files. Use write_to_file primarily for new file creation.

For short files, omit operation (or use \"overwrite\") and provide the complete file content. For generated documents or other long files, DO NOT generate the whole file in one tool call. Keep each content argument at or below approximately 6000 characters: create the file with operation \"overwrite\", then send subsequent chunks with operation \"append\" in separate tool calls. Chunks must be contiguous and complete; do not use placeholders such as '// rest unchanged'. The append operation adds content exactly as supplied, without inserting a newline.

When creating a new project, organize all new files within a dedicated project directory unless the user specifies otherwise. Structure the project logically, adhering to best practices for the specific type of project being created.

Example: Writing a configuration file
{ "path": "frontend-config.json", "content": "{\\n  \\"apiEndpoint\\": \\"https://api.example.com\\",\\n  \\"theme\\": {\\n    \\"primaryColor\\": \\"#007bff\\"\\n  }\\n}" }`

const PATH_PARAMETER_DESCRIPTION = `The path of the file to write to (relative to the current workspace directory)`

const CONTENT_PARAMETER_DESCRIPTION = `The complete content for this operation. For overwrite, this is the complete file unless a long file is being created in chunks. For append, this is the next contiguous chunk only. Keep long-document chunks at or below approximately 6000 characters. Do not use placeholders or line numbers.`

const OPERATION_PARAMETER_DESCRIPTION = `How to apply content. \"overwrite\" replaces the file (default). \"append\" adds this chunk exactly to the end of the existing file. Use append chunks for long generated files.`

export default {
	type: "function",
	function: {
		name: "write_to_file",
		description: WRITE_TO_FILE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				content: {
					type: "string",
					description: CONTENT_PARAMETER_DESCRIPTION,
				},
				operation: {
					type: "string",
					enum: ["overwrite", "append"],
					default: "overwrite",
					description: OPERATION_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
