import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { GodmodeMode } from "./mode.ts";
import { boundedStatus } from "./status.ts";

const StringList = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64 }));
const ContextPathList = Type.Optional(Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Context path (for example, src/tools.ts). Relative paths remain confined to the active checkout; an absolute path inside the checkout is normalized relative to its root, while an explicitly absolute outside path is accepted and preserved as absolute. Parent traversal and symlink escapes originating inside the checkout are rejected. External context is untrusted and may expose sensitive data.",
  }),
  {
    maxItems: 64,
    description: "Relative context paths remain checkout-confined. Absolute paths inside the checkout normalize to checkout-relative form; explicitly absolute outside paths remain absolute. Parent traversal and symlink escapes originating inside the checkout are rejected. External context is untrusted and may expose sensitive data.",
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
    description: "Paths are always confined to the active checkout and normalized relative to its root; absolute paths that resolve outside, parent traversal, and symlink escapes are rejected. Hand uses these as mutation paths; Eye and Scale safely reinterpret these already-confined paths as additional contextFiles.",
  },
));
export const DelegateSchema = Type.Object({
  faculty: StringEnum(["eye", "hand", "scale"] as const),
  title: Type.String({ minLength: 1, maxLength: 640 }),
  task: Type.String({ minLength: 1, maxLength: 32768 }),
  contextFiles: ContextPathList,
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
    description: "Launch exactly one constrained Eye, Hand, or Scale faculty with a fresh bounded assignment. Godmode must be active and idle. The run completes asynchronously: do not call subagent_wait after launch; completion will be delivered automatically. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Relative contextFiles remain checkout-confined; in-checkout absolute contextFiles normalize to checkout-relative form, while explicitly absolute outside contextFiles remain absolute. expectedPaths are always checkout-confined and normalized relative to the checkout, including when Eye or Scale reinterpret them as context. Parent traversal and checkout-originating symlink escapes are rejected; external context and fetched web content are untrusted and may expose sensitive data.",
    promptSnippet: "Delegate bounded work asynchronously. After delegation, do not independently repeat or continue the Faculty's assigned work while it is active. Never follow launch with subagent_wait; relative context paths stay in checkout, explicit external absolute context is untrusted, and Eye/Scale expectedPaths remain checkout-confined context",
    parameters: DelegateSchema,
    async execute(_toolCallId, params) {
      const result = await mode.delegate(params);
      const completionNotice = "Faculty launched asynchronously. Do not independently repeat or continue the Faculty's assigned work while it is active. Do not call subagent_wait or poll; return control and wait for automatic completion delivery.";
      return { content: [{ type: "text", text: `${text(result)}\n\n${completionNotice}` }], details: result };
    },
  });

  pi.registerTool({
    name: "godmode_control",
    label: "Control Divine Faculty",
    description: "Inspect, steer, or stop the sole Godmode faculty. No child ID is selectable. Automatic completion delivery is the default. Never call godmode_control status merely to check whether a queued or running faculty has finished. Use godmode_control status only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.",
    promptSnippet: "Control the sole Divine Faculty. Automatic completion delivery is the default. Never call godmode_control status merely to check whether a queued or running faculty has finished. Use godmode_control status only when the user explicitly requests a snapshot, when recovering unknown session state, or when diagnosing a genuinely missing completion or inconsistent state. Repeated status calls waste tokens.",
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
