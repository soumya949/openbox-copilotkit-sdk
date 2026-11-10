import {
  CopilotRuntime,
  CopilotKitIntelligence,
  createCopilotEndpoint,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { HttpAgent } from "@ag-ui/client";
import { withOpenBoxRuntime } from "@openbox-ai/openbox-copilotkit";
import { handle } from "hono/vercel";

const agentUrl = (
  process.env.AGENT_URL ||
  process.env.LANGGRAPH_DEPLOYMENT_URL ||
  "http://localhost:8123"
).replace(/\/+$/, "");

const defaultAgent = new HttpAgent({
  url: `${agentUrl}/`,
});

const runtimeOptions = {
  agents: { default: defaultAgent },
  // --- copilotkit:intelligence (remove this block to opt out) ---
  ...(process.env.COPILOTKIT_LICENSE_TOKEN
    ? {
        intelligence: new CopilotKitIntelligence({
          apiKey: process.env.INTELLIGENCE_API_KEY ?? "",
          apiUrl: process.env.INTELLIGENCE_API_URL ?? "http://localhost:4201",
          wsUrl:
            process.env.INTELLIGENCE_GATEWAY_WS_URL ?? "ws://localhost:4401",
        }),
        // Demo stub — replace with your real auth-derived user identity before any
        // multi-user deployment, or all users share one thread history.
        identifyUser: () => ({ id: "demo-user", name: "Demo User" }),
        licenseToken: process.env.COPILOTKIT_LICENSE_TOKEN,
      }
    : { runner: new InMemoryAgentRunner() }),
  // --- /copilotkit:intelligence ---
  openGenerativeUI: true,
  a2ui: {
    injectA2UITool: false,
  },
  mcpApps: {
    servers: [
      {
        type: "http",
        url: process.env.MCP_SERVER_URL || "https://mcp.excalidraw.com",
        serverId: "example_mcp_app",
      },
    ],
  },
} as ConstructorParameters<typeof CopilotRuntime>[0];

const runtime = await createRuntime(runtimeOptions);

async function createRuntime(
  options: ConstructorParameters<typeof CopilotRuntime>[0],
) {
  const apiUrl =
    process.env.OPENBOX_COPILOTKIT_API_URL ?? process.env.OPENBOX_URL;
  const apiKey =
    process.env.OPENBOX_COPILOTKIT_API_KEY ?? process.env.OPENBOX_API_KEY;

  if (!apiUrl || !apiKey) {
    return new CopilotRuntime(options);
  }

  const { runtime } = await withOpenBoxRuntime(options, {
    apiUrl,
    apiKey,
    agentDid:
      process.env.OPENBOX_COPILOTKIT_AGENT_DID ??
      process.env.OPENBOX_AGENT_DID,
    agentPrivateKey:
      process.env.OPENBOX_COPILOTKIT_AGENT_PRIVATE_KEY ??
      process.env.OPENBOX_AGENT_PRIVATE_KEY,
    workloadPrivateKey:
      process.env.OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY ??
      process.env.OPENBOX_WORKLOAD_PRIVATE_KEY,
    middlewareOptions: {
      // The Python LangGraph SDK is authoritative for backend enforcement.
      enforceApprovals: false,
      frontendToolNames: [
        "scheduleTime",
        "pieChart",
        "barChart",
        "toggleTheme",
        "enableAppMode",
        "enableChatMode",
      ],
    },
  });

  return runtime;
}

const app = createCopilotEndpoint({
  runtime,
  basePath: "/api/copilotkit",
});

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
