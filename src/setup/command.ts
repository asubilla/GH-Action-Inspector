import {
  CLIENT_SETUPS,
  defaultLaunch,
  describeClients,
  getClientSetup,
  MCP_SERVER_KEY,
  TOKEN_PLACEHOLDER,
  type SetupOptions,
} from "./clients.js";
import { securityNote } from "./advice.js";
import { defaultDetectionContext, detectClients, type DetectionContext } from "./detect.js";
import { formatDetectionJson, formatDetectionReport } from "./report.js";
import { runSetupWizard } from "./wizard.js";
import { writeClientConfig } from "./write-config.js";

const SETUP_USAGE = `Usage: gh-action-inspector setup [options]

With no options in a terminal, launch an interactive wizard that detects installed
clients and configures only the clients you select.

Print or install a stdio MCP configuration for a supported client.

Options:
  --detect        Show detected clients and evidence only; never writes configuration.
  --json          With --detect, print machine-readable JSON instead of text.
  --interactive   Force the interactive wizard (also works with piped answers).
  --client <id>   Client id (see list below), or "all" to print every snippet.
  --write         Merge the entry into the client's JSON config (backup + 0600 permissions).
  --local         Launch the local build (dist/cli.js) instead of the published npx package.
  --help          Show this help.

Supported clients:
${describeClients()}

Detection only (no prompts, no writes):
  gh-action-inspector setup --detect
  gh-action-inspector setup --detect --json

Security:
  A token placeholder is written, never a real token. Replace <YOUR_GITHUB_TOKEN> locally.
  This command never reads GITHUB_TOKEN and never prints credentials.`;

export async function runSetupCommand(
  args: readonly string[],
  detectionContext: DetectionContext = defaultDetectionContext(),
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${SETUP_USAGE}\n`);
    return 0;
  }

  const clientId = readFlag(args, "--client");
  const shouldWrite = args.includes("--write");
  const useLocal = args.includes("--local");
  const wantsInteractive = args.includes("--interactive") || args.includes("-i");
  const wantsDetection = args.includes("--detect");
  const wantsJson = args.includes("--json");
  const options: SetupOptions = {
    launch: defaultLaunch(useLocal),
    tokenPlaceholder: TOKEN_PLACEHOLDER,
  };

  if (wantsJson && !wantsDetection) {
    process.stderr.write("--json requires --detect.\n");
    return 1;
  }

  if (wantsDetection) {
    if (clientId !== undefined || shouldWrite || wantsInteractive) {
      process.stderr.write(
        "--detect cannot be combined with --client, --write, or --interactive.\n",
      );
      return 1;
    }
    const detections = detectClients(detectionContext);
    process.stdout.write(
      wantsJson ? formatDetectionJson(detections) : formatDetectionReport(detections),
    );
    return 0;
  }

  if (wantsInteractive && clientId !== undefined) {
    process.stderr.write("Use either --interactive or --client, not both.\n");
    return 1;
  }

  if (clientId === undefined) {
    const canPrompt =
      wantsInteractive || (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
    if (canPrompt) {
      try {
        const result = await runSetupWizard({
          launch: options.launch,
          context: detectionContext,
        });
        return result.failed.length > 0 ? 1 : 0;
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : "Setup wizard failed."}\n`,
        );
        return 1;
      }
    }
    process.stdout.write(
      `${SETUP_USAGE}\n\nExample (Cursor):\n\n${snippetFor("cursor", options)}\n`,
    );
    return 0;
  }

  if (clientId === "all") {
    if (shouldWrite) {
      process.stderr.write(
        "--write requires one specific --client; refusing to modify multiple clients.\n",
      );
      return 1;
    }
    for (const client of CLIENT_SETUPS) {
      process.stdout.write(
        `\n=== ${client.name} (${client.id}) ===\n\n${client.snippet(options)}\n`,
      );
    }
    process.stdout.write(`\n${securityNote()}\n`);
    return 0;
  }

  const client = getClientSetup(clientId);
  if (client === undefined) {
    process.stderr.write(`Unknown client "${clientId}".\n\n${describeClients()}\n`);
    return 1;
  }

  if (!shouldWrite) {
    process.stdout.write(
      `# ${client.name} (${client.id})\n\n${client.snippet(options)}\n\n${client.notes
        .map((note) => `- ${note}`)
        .join("\n")}\n\n${securityNote()}\n`,
    );
    return 0;
  }

  if (!client.writable) {
    process.stderr.write(
      `${client.name} is configured through its UI or CLI, so --write is not supported. Printed snippet:\n\n${client.snippet(options)}\n`,
    );
    return 1;
  }

  try {
    const result = await writeClientConfig(client, options);
    process.stdout.write(
      [
        `Installed ${client.name} MCP entry "${MCP_SERVER_KEY}" in:`,
        `  ${result.path}${result.created ? " (created)" : " (merged)"}`,
        result.backupPath !== null ? `Backup: ${result.backupPath}` : "",
        "",
        `Replace ${TOKEN_PLACEHOLDER} in the file with a read-only GitHub token, then restart ${client.name}.`,
        "The file was written with owner-only (0600) permissions. Do not commit it.",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Could not write configuration."}\n`,
    );
    return 1;
  }
}

function snippetFor(clientId: string, options: SetupOptions): string {
  const client = getClientSetup(clientId);
  return client?.snippet(options) ?? "";
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("-") ? undefined : value;
}
