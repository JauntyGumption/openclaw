import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  PROGRESS_CARD_MAX_STEPS,
  ProgressCardStepSchema,
  type ProgressCardPutResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeProgressCardInput,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const ProgressCardToolSchema = Type.Object(
  {
    markdown: Type.Optional(Type.String()),
    plan: Type.Optional(Type.Array(ProgressCardStepSchema, { maxItems: PROGRESS_CARD_MAX_STEPS })),
  },
  { additionalProperties: false },
);

type ProgressCardToolOptions = {
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
};

export function createProgressCardTool(options: ProgressCardToolOptions = {}): AnyAgentTool {
  const gatewayCall = options.callGateway ?? callInProcessGatewayTool;
  return {
    name: "progress_card",
    label: "Progress Card",
    description:
      'Publish or clear this session\'s durable progress card, a status surface shown next to the session in OpenClaw\'s UIs. Each call replaces the whole card. `markdown` provides a compact note and may include ordinary Markdown, tables, links, or a <progress value="3" max="7"></progress> bar; other raw HTML is stripped. `plan` provides an ordered step checklist with pending, in_progress, or completed status and at most one in_progress step. Either part may be omitted. Call with both parts empty to clear. Max 8 KB markdown, 50 steps.',
    parameters: ProgressCardToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const sessionKey = options.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new ToolInputError("progress_card requires an agent session");
      }
      let input;
      try {
        const params = asOptionalObjectRecord(rawArgs);
        input = normalizeProgressCardInput({
          markdown: params?.markdown,
          plan: params?.plan,
        });
      } catch (error) {
        if (error instanceof ProgressCardInputError) {
          throw new ToolInputError(error.message);
        }
        throw error;
      }
      const result = await gatewayCall<ProgressCardPutResult>("progressCard.put", {
        sessionKey,
        ...(input.markdown ? { markdown: input.markdown } : {}),
        ...(input.steps ? { plan: input.steps } : {}),
      });
      const completed =
        result.card?.steps?.filter((step) => step.status === "completed").length ?? 0;
      const total = result.card?.steps?.length ?? 0;
      const payload = {
        revision: result.card?.revision ?? null,
        steps: total > 0 ? { completed, total } : null,
      };
      const json = jsonResult(payload);
      return {
        ...json,
        content: [
          {
            type: "text",
            text: !result.card
              ? "Progress card cleared"
              : total > 0
                ? `Progress card updated (rev ${result.card.revision}, ${completed}/${total} done)`
                : `Progress card updated (rev ${result.card.revision})`,
          },
          ...json.content,
        ],
      };
    },
  };
}
