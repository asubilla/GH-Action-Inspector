import { TriageError } from "../errors.js";

/**
 * Only workflow files at the documented GitHub location are readable through the
 * metadata tool. This prevents the tool from becoming a general repository-file
 * reader and blocks path traversal.
 */
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]{1,190}\.(?:yml|yaml)$/;

export function isWorkflowPath(value: string): boolean {
  return WORKFLOW_PATH.test(value) && !value.includes("..");
}

export function assertWorkflowPath(value: string): void {
  if (!isWorkflowPath(value)) {
    throw new TriageError(
      "INVALID_INPUT",
      "Only workflow files under .github/workflows ending in .yml or .yaml can be read.",
      {
        hint: "Pass a path such as .github/workflows/ci.yml. Other repository files are intentionally not accessible.",
      },
    );
  }
}
