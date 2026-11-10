import {
  CopilotRuntime,
  CopilotKitIntelligence,
  createCopilotEndpoint,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { MastraAgent } from "@ag-ui/mastra";
import { mastra } from "@/mastra";
import { handle } from "hono/vercel";
import { withOpenBoxRuntime } from "@openbox-ai/openbox-copilotkit";

const OPENBOX_URL = process.env.OPENBOX_URL;
const OPENBOX_COPILOTKIT_API_KEY =
  process.env.OPENBOX_COPILOTKIT_API_KEY ?? process.env.OPENBOX_API_KEY;
const OPENBOX_COPILOTKIT_AGENT_DID =
  process.env.OPENBOX_COPILOTKIT_AGENT_DID ?? process.env.OPENBOX_AGENT_DID;
const OPENBOX_COPILOTKIT_AGENT_PRIVATE_KEY =
  process.env.OPENBOX_COPILOTKIT_AGENT_PRIVATE_KEY ??
  process.env.OPENBOX_AGENT_PRIVATE_KEY;
const OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY =
  process.env.OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY ??
  process.env.OPENBOX_WORKLOAD_PRIVATE_KEY;
const OPENBOX_MASTRA_API_KEY = process.env.OPENBOX_MASTRA_API_KEY;
const OPENBOX_MASTRA_AGENT_DID = process.env.OPENBOX_MASTRA_AGENT_DID;
const OPENBOX_MASTRA_AGENT_PRIVATE_KEY =
  process.env.OPENBOX_MASTRA_AGENT_PRIVATE_KEY;

const runtimeOptions = {
  agents: MastraAgent.getLocalAgents({ mastra }),
  // --- copilotkit:intelligence (remove this block to opt out) ---
  ...(process.env.COPILOTKIT_LICENSE_TOKEN
    ? {
        intelligence: new CopilotKitIntelligence({
          apiKey: process.env.INTELLIGENCE_API_KEY ?? "",
          apiUrl: process.env.INTELLIGENCE_API_URL ?? "http://localhost:4201",
          wsUrl:
            process.env.INTELLIGENCE_GATEWAY_WS_URL ?? "ws://localhost:4401",
        }),
        // Demo stub — replace with your own auth-derived user identity (e.g. OIDC)
        // before any multi-user deployment, or all users share one thread history.
        identifyUser: () => ({ id: "demo-user", name: "Demo User" }),
        licenseToken: process.env.COPILOTKIT_LICENSE_TOKEN,
      }
    : { runner: new InMemoryAgentRunner() }),
  // --- /copilotkit:intelligence ---
} as ConstructorParameters<typeof CopilotRuntime>[0];

const runtime = await createRuntime(runtimeOptions);

async function createRuntime(
  options: ConstructorParameters<typeof CopilotRuntime>[0],
) {
  if (!OPENBOX_COPILOTKIT_API_KEY || !OPENBOX_URL) {
    return new CopilotRuntime(options);
  }

  const multiAgentOptions = getMultiAgentOptions();
  const { runtime } = await withOpenBoxRuntime(options, {
    apiKey: OPENBOX_COPILOTKIT_API_KEY,
    apiUrl: OPENBOX_URL,
    agentDid: OPENBOX_COPILOTKIT_AGENT_DID,
    agentPrivateKey: OPENBOX_COPILOTKIT_AGENT_PRIVATE_KEY,
    workloadPrivateKey: OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY,
    middlewareOptions: {
      enforceApprovals: false,
      frontendToolNames: ["setThemeColor", "weatherTool", "go_to_moon"],
      onEvent: (emission) => {
        const payload = emission.payload as Record<string, unknown>;
        console.info("[openbox-copilotkit-parent]", {
          activity_id: emission.activityId,
          activity_type: payload.activity_type,
          event_type: emission.eventType,
          multi_agent_session_id: payload.multi_agent_session_id,
          workflow_id: emission.workflowId,
          workflow_type: payload.workflow_type,
        });
      },
      ...(multiAgentOptions ? { multiAgent: multiAgentOptions } : {}),
    },
  });

  return runtime;
}

// Multi-agent handoff identifies the parent and child by their DIDs, so it is
// only enabled for agents registered with a DID. Workload-identity agents run
// as two separately governed agents.
function getMultiAgentOptions() {
  if (
    !OPENBOX_COPILOTKIT_AGENT_DID ||
    !OPENBOX_MASTRA_API_KEY ||
    !OPENBOX_MASTRA_AGENT_DID ||
    !OPENBOX_MASTRA_AGENT_PRIVATE_KEY
  ) {
    return undefined;
  }

  const mastraChild = {
    childAgentName: "mastra-weather-agent",
    childWorkflowType: "weather-agent",
    childTaskQueue: "mastra",
    childApiKey: OPENBOX_MASTRA_API_KEY,
    childAgentDid: OPENBOX_MASTRA_AGENT_DID,
    childAgentPrivateKey: OPENBOX_MASTRA_AGENT_PRIVATE_KEY,
  };

  return {
    enabled: true,
    parentAgentDid: OPENBOX_COPILOTKIT_AGENT_DID,
    handoffTools: {
      weatherTool: mastraChild,
      "get-weather": mastraChild,
    },
  };
}

const app = createCopilotEndpoint({
  runtime,
  basePath: "/api/copilotkit",
});

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
