import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  defaultLaunch,
  TOKEN_PLACEHOLDER,
  type ClientId,
  type ClientSetup,
  type LaunchConfig,
  type SetupOptions,
} from "./clients.js";
import {
  defaultDetectionContext,
  detectClients,
  type ClientDetection,
  type DetectionContext,
} from "./detect.js";
import { writeClientConfig } from "./write-config.js";
import { nextStepNote, securityNote } from "./advice.js";
import { SERVER_TITLE } from "../version.js";

export interface WizardOptions {
  input?: Readable;
  output?: Writable;
  context?: Partial<DetectionContext>;
  launch?: LaunchConfig;
}

export interface WizardResult {
  cancelled: boolean;
  installed: ClientId[];
  printed: ClientId[];
  failed: Array<{ id: ClientId; message: string }>;
}

class LinePrompter {
  private readonly readline: Interface;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    const terminal = Boolean(
      (input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY,
    );
    this.readline = createInterface({ input, output, terminal });
    this.readline.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) waiter(line);
      else this.lines.push(line);
    });
    this.readline.on("close", () => {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()?.(null);
    });
    this.readline.on("SIGINT", () => {
      this.output.write("\n");
      this.readline.close();
    });
  }

  async ask(prompt: string): Promise<string | null> {
    this.output.write(prompt);
    const queued = this.lines.shift();
    if (queued !== undefined) return queued;
    if (this.closed) return null;
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.readline.close();
  }
}

function resolveContext(overrides: Partial<DetectionContext> | undefined): DetectionContext {
  const base = defaultDetectionContext();
  if (overrides === undefined) return base;
  return {
    home: overrides.home ?? base.home,
    cwd: overrides.cwd ?? base.cwd,
    platform: overrides.platform ?? base.platform,
    env: overrides.env ?? base.env,
  };
}

function renderClients(detections: readonly ClientDetection[], output: Writable): void {
  output.write("Detected MCP clients:\n\n");
  detections.forEach((detection, index) => {
    const status = detection.installed ? "detected" : "not detected";
    output.write(
      `  ${String(index + 1).padStart(2)}. ${detection.client.name.padEnd(38)} ${status}\n`,
    );
    for (const hint of detection.evidence.slice(0, 2)) {
      output.write(`      ${hint}\n`);
    }
  });
  output.write("\n");
  if (!detections.some((detection) => detection.installed)) {
    output.write(
      "No supported clients were detected automatically. You can still choose any number below.\n\n",
    );
  }
}

function parseSelection(answer: string, clientCount: number): number[] | null {
  const parts = answer.split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const indices: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const index = Number(part) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= clientCount) return null;
    indices.push(index);
  }
  return [...new Set(indices)];
}

async function selectClients(
  prompt: LinePrompter,
  output: Writable,
  detections: readonly ClientDetection[],
): Promise<ClientDetection[] | null> {
  const detectedIndices = detections
    .map((detection, index) => (detection.installed ? index : -1))
    .filter((index) => index >= 0);
  const defaultChoice = detectedIndices.length > 0 ? "d" : "";

  for (;;) {
    const suffix = defaultChoice === "d" ? " [d: detected only]" : "";
    const answer = await prompt.ask(
      `Select clients by number (comma-separated, "a" = all, "q" = quit)${suffix}: `,
    );
    if (answer === null) return null;

    const normalized = answer.trim().toLowerCase();
    if (normalized === "q" || normalized === "quit") return null;

    if (normalized === "" && defaultChoice === "d") {
      return detectedIndices.map((index) => detections[index]!).filter(Boolean);
    }
    if (normalized === "d") {
      if (detectedIndices.length === 0) {
        output.write('No clients were detected. Enter numbers, "a", or "q".\n');
        continue;
      }
      return detectedIndices.map((index) => detections[index]!).filter(Boolean);
    }
    if (normalized === "a") return [...detections];

    const indices = parseSelection(normalized, detections.length);
    if (indices === null) {
      output.write(`Enter numbers 1-${detections.length}, "d", "a", or "q".\n`);
      continue;
    }
    return indices.map((index) => detections[index]!).filter(Boolean);
  }
}

async function chooseAction(
  prompt: LinePrompter,
  output: Writable,
): Promise<"install" | "print" | null> {
  for (;;) {
    const answer = await prompt.ask(
      "Configure selected clients: [1] install writable configs, [2] print snippets only: ",
    );
    if (answer === null) return null;
    const normalized = answer.trim().toLowerCase();
    if (normalized === "" || normalized === "1" || normalized === "i" || normalized === "install") {
      return "install";
    }
    if (normalized === "2" || normalized === "p" || normalized === "print") return "print";
    if (normalized === "q" || normalized === "quit") return null;
    output.write("Enter 1 to install, 2 to print, or q to cancel.\n");
  }
}

function printSnippet(
  output: Writable,
  client: ClientSetup,
  options: SetupOptions,
  installRequested: boolean,
): void {
  output.write(`\n${client.name} (${client.id})\n\n${client.snippet(options)}\n\n`);
  output.write(`${client.notes.map((note) => `- ${note}`).join("\n")}\n`);
  if (installRequested && !client.writable) {
    output.write("\nThis client is configured through its UI or CLI, so no file was changed.\n");
  }
}

/**
 * Interactive setup: detect supported clients, let the user pick a subset, and
 * touch only those clients. It writes placeholder tokens only, never reads
 * GITHUB_TOKEN, and never modifies unselected client configurations.
 */
export async function runSetupWizard(options: WizardOptions = {}): Promise<WizardResult> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const context = resolveContext(options.context);
  const launch = options.launch ?? defaultLaunch(false);
  const setup: SetupOptions = { launch, tokenPlaceholder: TOKEN_PLACEHOLDER };
  const result: WizardResult = {
    cancelled: false,
    installed: [],
    printed: [],
    failed: [],
  };

  output.write(
    [
      `${SERVER_TITLE} interactive setup`,
      "",
      "This wizard scans for supported MCP clients. It changes only the clients you select.",
      "It writes a token placeholder, never a real token, and does not read GITHUB_TOKEN.",
      "",
    ].join("\n"),
  );

  const detections = detectClients(context);
  renderClients(detections, output);

  const prompt = new LinePrompter(input, output);
  try {
    const selected = await selectClients(prompt, output, detections);
    if (selected === null) {
      output.write("\nSetup cancelled. No configuration was changed.\n");
      result.cancelled = true;
      return result;
    }

    const action = await chooseAction(prompt, output);
    if (action === null) {
      output.write("\nSetup cancelled. No configuration was changed.\n");
      result.cancelled = true;
      return result;
    }

    output.write(
      `\n${action === "install" ? "Installing" : "Printing"} configuration for: ${selected
        .map((detection) => detection.client.name)
        .join(", ")}\n`,
    );

    for (const detection of selected) {
      const client = detection.client;
      if (action === "print" || !client.writable) {
        printSnippet(output, client, setup, action === "install");
        result.printed.push(client.id);
        continue;
      }

      try {
        const writeResult = await writeClientConfig(client, setup, {
          home: context.home,
          cwd: context.cwd,
        });
        output.write(
          `\nInstalled ${client.name} in ${writeResult.path} (${writeResult.created ? "created" : "merged"}).\n`,
        );
        if (writeResult.backupPath !== null) {
          output.write(`Backup: ${writeResult.backupPath}\n`);
        }
        result.installed.push(client.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        result.failed.push({ id: client.id, message });
        output.write(`\nCould not install ${client.name}: ${message}\n`);
      }
    }
  } finally {
    prompt.close();
  }

  output.write(
    [
      "",
      "Summary:",
      `  Installed: ${result.installed.length > 0 ? result.installed.join(", ") : "none"}`,
      `  Printed:   ${result.printed.length > 0 ? result.printed.join(", ") : "none"}`,
      `  Failed:    ${result.failed.length > 0 ? result.failed.map((failure) => failure.id).join(", ") : "none"}`,
      "",
    ].join("\n"),
  );

  if (result.installed.length > 0) {
    output.write(`\n${nextStepNote()}\n\n${securityNote()}\n`);
  }
  if (result.failed.length > 0) {
    output.write(
      "\nSome clients could not be installed. Fix the errors above or use the printed snippets.\n",
    );
  }

  return result;
}
