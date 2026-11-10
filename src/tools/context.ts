import type { AppConfig } from "../config.js";
import type { GitHubReader } from "../github/types.js";
import type { Logger } from "../logger.js";

export interface ToolContext {
  readonly client: GitHubReader;
  readonly config: AppConfig;
  readonly logger: Logger;
}
