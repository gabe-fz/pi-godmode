import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { GodmodeMode } from "./mode.ts";
import { boundedStatus } from "./status.ts";

const StringList = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64 }));
const CheckoutPathList = Type.Optional(Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Checkout path (for example, src/tools.ts). The normalized path is relative to the active checkout root and never an absolute path; absolute input is accepted only when it resolves inside the checkout.",
  }),
  {
    maxItems: 64,
    description: "Paths are relative to the active checkout root after normalization and never an absolute path; absolute input is accepted only when it resolves inside the checkout, while outside or escaping symlink paths are rejected.",
  },
));
const ExpectedPathList = Type.Optional(Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Checkout path (for example, src/tools.ts). The normalized path is relative to the active checkout root and never an absolute path; absolute input is accepted only when it resolves inside the checkout.",
  }),
  {
    maxItems: 64,
    description: "Paths are relative to the active checkout root after normalization and never an absolute path. Hand uses these as mutation paths; Eye and Scale safely reinterpret expectedPaths as additional contextFiles. Outside or escaping symlink paths are rejected.",
  },
));
export const DelegateSchema = Type.Object({
  faculty: StringEnum(["eye", "hand", "scale"] as const),
  title: Type.String({ minLength: 1, maxLength: 640 }),
  task: Type.String({ minLength: 1, maxLength: 32768 }),
  contextFiles: CheckoutPathList,
  expectedPaths: ExpectedPathList,
  acceptanceChecks: StringList,
  constraints: StringList,
}, { additionalProperties: false });

export const ControlSchema = Type.Object({
  action: StringEnum(["status", "steer", "stop"] as const),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
  reason: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });

export type DelegateParams = Static<typeof DelegateSchema>;
export type ControlParams = Static<typeof ControlSchema>;

function text(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function registerGodmodeTools(pi: ExtensionAPI, mode: GodmodeMode): void {
  pi.registerTool({
    name: "godmode_delegate",
    label: "Delegate Divine Faculty",
    description: "Launch exactly one constrained Eye, Hand, or Scale faculty with a fresh bounded assignment. Godmode must be active and idle. The run completes asynchronously: do not call subagent_wait after launch; completion will be delivered automatically. contextFiles and expectedPaths accept relative paths or absolute paths that resolve inside the active checkout; absolute paths are normalized to checkout-relative form, while outside paths and escaping symlinks are rejected. For Eye and Scale, expectedPaths are safely treated as additional contextFiles rather than mutation scope.",
    promptSnippet: "Delegate bounded work asynchronously; never follow launch with subagent_wait; paths must resolve within the active checkout; Eye/Scale expectedPaths become contextFiles",
    parameters: DelegateSchema,
    async execute(_toolCallId, params) {
      const result = await mode.delegate(params);
      const completionNotice = "Faculty launched asynchronously. Do not call subagent_wait or poll; return control and wait for automatic completion delivery.";
      return { content: [{ type: "text", text: `${text(result)}\n\n${completionNotice}` }], details: result };
    },
  });

  pi.registerTool({
    name: "godmode_control",
    label: "Control Divine Faculty",
    description: "Inspect, steer, or stop the sole Godmode faculty. No child ID is selectable.",
    promptSnippet: "Inspect, steer, or stop the sole active Divine Faculty",
    parameters: ControlSchema,
    async execute(_toolCallId, params) {
      if (params.action === "status") {
        if (params.message !== undefined || params.reason !== undefined) throw new Error("godmode_control status accepts only action.");
        const snapshot = mode.snapshot.activeRun?.runId ? await mode.status() : mode.snapshot;
        const result = boundedStatus(snapshot);
        return { content: [{ type: "text", text: text(result) }], details: result };
      }
      if (params.action === "steer") {
        if (!params.message?.trim() || params.reason !== undefined) throw new Error("godmode_control steer requires message and rejects reason.");
        const result = boundedStatus(await mode.steer(params.message));
        return { content: [{ type: "text", text: text(result) }], details: result };
      }
      if (params.message !== undefined) throw new Error("godmode_control stop rejects message; use optional reason.");
      const result = boundedStatus(await mode.stop(params.reason));
      return { content: [{ type: "text", text: text(result) }], details: result };
    },
  });
}
