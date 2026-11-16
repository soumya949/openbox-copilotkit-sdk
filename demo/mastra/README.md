# OpenBox CopilotKit + Mastra Demo

This demo runs a CopilotKit UI with a Mastra weather agent and both OpenBox SDKs wired for multi-agent timeline testing.

It lives inside the `@openbox-ai/openbox-copilotkit` repository so the demo can use the local SDK build directly:

- `@openbox-ai/openbox-copilotkit` is installed from `file:../..`.
- `@openbox-ai/openbox-mastra-sdk` is installed from npm.

## Prerequisites

- Node.js 18+
- Any of the following package managers:
  - npm (default)
  - [pnpm](https://pnpm.io/installation)
  - [yarn](https://classic.yarnpkg.com/lang/en/docs/install/)
  - [bun](https://bun.sh/)

## Getting Started

1. Create your local environment file

```bash
cp .env.example .env
```

Then fill in `OPENAI_API_KEY`. You can use any model/provider supported by Mastra.

2. Optional: enable OpenBox governance and telemetry

Fill these values in `.env`:

- `OPENBOX_URL`
- `OPENBOX_COPILOTKIT_API_KEY` and `OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY`
- `OPENBOX_MASTRA_API_KEY` and `OPENBOX_MASTRA_WORKLOAD_PRIVATE_KEY`

Each workload private key is the PEM shown when you create the agent (IAM v3 workload identity); keep it inside double quotes in `.env`. Agents registered with a DID use `OPENBOX_COPILOTKIT_AGENT_DID` / `OPENBOX_COPILOTKIT_AGENT_PRIVATE_KEY` and `OPENBOX_MASTRA_AGENT_DID` / `OPENBOX_MASTRA_AGENT_PRIVATE_KEY` instead. The parent/child handoff timeline identifies agents by DID, so it is only enabled when both agents have one; with workload identity the CopilotKit runtime and the Mastra agent are governed as two separate agents.

The OpenBox wrappers are opt-in: without OpenBox keys and `OPENBOX_URL`, the example runs as the standard CopilotKit + Mastra starter. For simple single-agent testing, the SDKs also fall back to `OPENBOX_API_KEY` and `OPENBOX_WORKLOAD_PRIVATE_KEY` (or `OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY`); for multi-agent testing, use the distinct CopilotKit and Mastra variables above.

3. Install dependencies using your preferred package manager:

```bash
# Using npm (default)
npm install

# Using pnpm
pnpm install

# Using yarn
yarn install

# Using bun
bun install
```

4. Start the development server:

```bash
# Using npm (default)
npm run dev

# Using pnpm
pnpm dev

# Using yarn
yarn dev

# Using bun
bun run dev
```

This builds the local `@openbox-ai/openbox-copilotkit` package first, then starts both the UI and agent servers concurrently.

## OpenBox Integration

This example wires both OpenBox SDKs:

- `@openbox-ai/openbox-mastra-sdk` wraps the Mastra instance and observes agent runs, backend tool calls, LLM completions, and Mastra workflow activity.
- `@openbox-ai/openbox-copilotkit` wraps the CopilotKit runtime route and observes CopilotKit request boundaries, AG-UI messages, frontend tools, and HITL surfaces.

For multi-agent testing, register two distinct OpenBox agents:

- CopilotKit parent/orchestrator: `OPENBOX_COPILOTKIT_*`
- Mastra child/subagent: `OPENBOX_MASTRA_*`

When both identities are configured, the CopilotKit wrapper enables multi-agent mode and maps both `weatherTool` and `get-weather` as handoff tools to the Mastra child. OpenBox Core receives a child-authenticated `Handoff` event with `from_agent_did` set to the CopilotKit parent.

When both SDKs are enabled in the same local process, OpenBox can show separate `workflow_type: "mastra"` and `workflow_type: "copilotkit"` streams for one chat turn. A grouped multi-agent timeline additionally requires the child Mastra stream to stamp the same `multi_agent_session_id` and `parent_workflow_id`.

The OpenBox SDKs require Node.js `>=24.10.0`. This example also keeps the OpenBox packages in `next.config.ts` `serverExternalPackages` because they are server-only packages.

## Available Scripts

The following scripts can also be run using your preferred package manager:

- `dev` - Starts both UI and agent servers in development mode
- `dev:ui` - Starts only the Next.js UI server
- `dev:agent` - Starts only the Mastra agent server
- `dev:debug` - Starts development servers with debug logging enabled
- `build` - Builds the application for production
- `start` - Starts the production server

## Documentation

- [Mastra Documentation](https://mastra.ai/en/docs) - Learn more about Mastra and its features
- [CopilotKit Documentation](https://docs.copilotkit.ai) - Explore CopilotKit's capabilities
- [Next.js Documentation](https://nextjs.org/docs) - Learn about Next.js features and API

## Contributing

Feel free to submit issues and enhancement requests!

## License

This project is licensed under the MIT License - see the LICENSE file for details.
