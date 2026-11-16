import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { weatherAgent } from "./agents";
import { ConsoleLogger, LogLevel } from "@mastra/core/logger";
import { withOpenBox } from "@openbox-ai/openbox-mastra-sdk";

const LOG_LEVEL = (process.env.LOG_LEVEL as LogLevel) || "info";
const OPENBOX_URL = process.env.OPENBOX_URL;
const OPENBOX_MASTRA_API_KEY =
  process.env.OPENBOX_MASTRA_API_KEY ?? process.env.OPENBOX_API_KEY;
const OPENBOX_MASTRA_AGENT_DID =
  process.env.OPENBOX_MASTRA_AGENT_DID ?? process.env.OPENBOX_AGENT_DID;
const OPENBOX_MASTRA_AGENT_PRIVATE_KEY =
  process.env.OPENBOX_MASTRA_AGENT_PRIVATE_KEY ??
  process.env.OPENBOX_AGENT_PRIVATE_KEY;
const OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY =
  process.env.OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY ??
  process.env.OPENBOX_WORKLOAD_PRIVATE_KEY;
const OPENBOX_MASTRA_MULTI_AGENT_ENABLED =
  process.env.OPENBOX_MASTRA_MULTI_AGENT_ENABLED !== "false";
const OPENBOX_MASTRA_MULTI_AGENT_SESSION_ID =
  process.env.OPENBOX_MASTRA_MULTI_AGENT_SESSION_ID?.trim();
const openBoxMastraMultiAgent = {
  enabled: OPENBOX_MASTRA_MULTI_AGENT_ENABLED,
  ...(OPENBOX_MASTRA_MULTI_AGENT_SESSION_ID
    ? { multiAgentSessionId: OPENBOX_MASTRA_MULTI_AGENT_SESSION_ID }
    : {}),
};

const baseMastra = new Mastra({
  agents: {
    default: weatherAgent,
  },
  storage: new LibSQLStore({
    id: "mastra-storage",
    url: ":memory:",
  }),
  logger: new ConsoleLogger({
    level: LOG_LEVEL,
  }),
});

export const mastra =
  OPENBOX_MASTRA_API_KEY && OPENBOX_URL
    ? await withOpenBox(baseMastra, {
        apiKey: OPENBOX_MASTRA_API_KEY,
        apiUrl: OPENBOX_URL,
        agentDid: OPENBOX_MASTRA_AGENT_DID,
        agentPrivateKey: OPENBOX_MASTRA_AGENT_PRIVATE_KEY,
        workloadPrivateKey: OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY,
        multiAgent: openBoxMastraMultiAgent,
      })
    : baseMastra;
