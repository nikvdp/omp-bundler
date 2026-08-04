import { basename, join } from "node:path";
import { assertSafeIdentifier } from "../identifiers.ts";
import { createFilePlan } from "../file-plan.ts";
import { resolveCommandPath } from "../project.ts";
import type { CommandHandler } from "../types.ts";
import {
  applyAndReport,
  assertAllowedOptions,
  assertPathAbsent,
  requiredOptionString,
} from "./common.ts";
import { agentScaffoldFiles, bundleFiles } from "./templates.ts";

export const newCommand: CommandHandler = async (args, context) => {
  assertAllowedOptions(args, ["id", "dry-run"]);
  if (args.positionals.length !== 1) {
    throw new Error("usage: omp-bundler new <path> [--id <agent-id>] [--dry-run]");
  }
  const destination = resolveCommandPath(args.positionals[0], context.cwd);
  await assertPathAbsent(destination, "bundle destination");
  const bundleName = basename(destination);
  assertSafeIdentifier(bundleName, "bundle name");
  const agentId = args.options.id === undefined ? bundleName : requiredOptionString(args, "id");
  assertSafeIdentifier(agentId, "agent id");

  const writes = [
    ...bundleFiles(bundleName, agentId),
    ...agentScaffoldFiles(agentId),
  ];
  const plan = await createFilePlan(destination, writes);
  await applyAndReport(plan, context, args.options["dry-run"] === true);
};
