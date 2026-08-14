import fs from "node:fs";
import path from "node:path";

/**
 * Runtime-mutable adapter settings.
 *
 * These are deliberately not environment variables. Env is read once at
 * container start, which means changing behavior requires a rebuild and the
 * agent can never change its own behavior. Settings live in a JSONC file on
 * the durable volume that the agent can edit with ordinary file tools, the
 * same way it owns `/data/cron/schedules`.
 *
 * Values resolve at read time: defaults below are the source of truth and the
 * file supplies overrides. A settings file written by an older version is
 * therefore never wrong, only partial, and a newly added setting picks up its
 * default with no migration step.
 */
export interface AdapterSettings {
  /**
   * Post an interim message while the model works, editing it as text
   * arrives. Streaming is a direct-message affordance: in a channel it is a
   * message mutating in place while other people are talking.
   */
  streamInDirectMessages: boolean;
  streamInChannels: boolean;
  /**
   * Reply inside a thread on the triggering message when the message came
   * from a public channel. Direct messages always reply inline, since a DM is
   * already private and threading only adds a click.
   */
  threadRepliesInChannels: boolean;
}

export const SETTING_DEFAULTS: AdapterSettings = {
  streamInDirectMessages: true,
  streamInChannels: false,
  threadRepliesInChannels: true,
};

/** Seeded into the durable volume on first boot, then owned by the agent. */
export const SETTINGS_TEMPLATE = `// Adapter runtime settings.
//
// Edited while the agent is running: changes are picked up on the next
// message, with no restart or rebuild. Any key removed from this file falls
// back to its built-in default, so it is safe to keep this file sparse and
// list only what you deliberately want to change.
{
  // Post an interim message and edit it as the reply is written.
  // Worth having in a DM, where the conversation is just the two of you.
  "streamInDirectMessages": true,

  // Off in channels on purpose: a message mutating in place while other
  // people are talking is noise, and a turn that ends up silent would
  // otherwise flash a partial message and then delete it.
  "streamInChannels": false,

  // Reply in a thread on the triggering message when replying in a channel,
  // which keeps the main channel readable. DMs always reply inline.
  "threadRepliesInChannels": true
}
`;

/** Strip `//` and block comments so JSON.parse accepts a JSONC document. */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

type Logger = Pick<Console, "warn">;

/**
 * Reads settings from disk, re-reading when the file changes.
 *
 * The in-memory value is guaranteed to match what is persisted: reads check
 * the file's mtime and size before returning, and writes go through to disk
 * before updating memory. A malformed file keeps the last good values rather
 * than taking the agent down, since these are behavior knobs and a typo in
 * one of them should not stop it answering.
 */
export class SettingsStore {
  private readonly file: string;
  private readonly logger: Logger;
  private cached: AdapterSettings = { ...SETTING_DEFAULTS };
  private stamp = "";
  private warned = "";

  constructor(options: { file: string; logger?: Logger }) {
    this.file = options.file;
    this.logger = options.logger ?? console;
  }

  /** Absolute path of the backing file, for logs and diagnostics. */
  get filePath(): string {
    return this.file;
  }

  /**
   * Write the commented template if no settings file exists yet.
   *
   * Seeding a real file rather than an example makes the extension point
   * discoverable: the agent can read the file to see what it can change. It
   * is inert either way, since every value in it equals its default.
   */
  seed(): void {
    if (fs.existsSync(this.file)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, SETTINGS_TEMPLATE, { flag: "wx", mode: 0o644 });
    } catch (error) {
      // A racing writer won, or the volume is read-only. Defaults still apply.
      this.warnOnce("seed", error);
    }
  }

  /** Current settings, re-read from disk when the file has changed. */
  get(): AdapterSettings {
    let info: fs.Stats;
    try {
      info = fs.statSync(this.file);
    } catch {
      // No file yet: defaults are the answer, and a later write creates it.
      this.stamp = "";
      this.cached = { ...SETTING_DEFAULTS };
      return this.cached;
    }
    const stamp = `${info.mtimeMs}:${info.size}`;
    if (stamp === this.stamp) return this.cached;
    this.cached = this.read();
    this.stamp = stamp;
    return this.cached;
  }

  /**
   * Persist a partial update, then return the merged result. Written to a
   * temporary file and renamed so a concurrent reader never observes a
   * half-written document.
   */
  set(patch: Partial<AdapterSettings>): AdapterSettings {
    const merged = { ...this.get(), ...patch };
    const body = `${JSON.stringify(merged, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, body, { mode: 0o644 });
    fs.renameSync(temp, this.file);
    this.cached = merged;
    try {
      const info = fs.statSync(this.file);
      this.stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      this.stamp = "";
    }
    return merged;
  }

  private read(): AdapterSettings {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      this.warnOnce("read", error);
      return this.cached;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(raw) || "{}");
    } catch (error) {
      this.warnOnce("parse", error);
      return this.cached;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.warnOnce("shape", new Error("settings must be a JSON object"));
      return this.cached;
    }
    this.warned = "";
    const record = parsed as Record<string, unknown>;
    const next = { ...SETTING_DEFAULTS };
    for (const key of Object.keys(SETTING_DEFAULTS) as (keyof AdapterSettings)[]) {
      const value = record[key];
      if (typeof value === "boolean") next[key] = value;
      else if (value !== undefined) {
        this.warnOnce(
          `type:${key}`,
          new Error(`${key} must be a boolean, ignoring ${typeof value}`),
        );
      }
    }
    return next;
  }

  /** Log a given failure once so a persistently bad file cannot spam logs. */
  private warnOnce(kind: string, error: unknown): void {
    if (this.warned === kind) return;
    this.warned = kind;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `>>> Pumble settings ${this.file}: ${message}; using previous values`,
    );
  }
}
