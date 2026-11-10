# OpenBox + CopilotKit + LangGraph Starter

This is the original CopilotKit LangGraph Python starter with optional OpenBox governance and telemetry at both the CopilotKit and LangGraph boundaries.

https://github.com/user-attachments/assets/47761912-d46a-4fb3-b9bd-cb41ddd02e34

## Prerequisites

- Node.js 24.10+
- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Any of the following package managers:
  - npm (default)
  - [pnpm](https://pnpm.io/installation)
  - [yarn](https://classic.yarnpkg.com/lang/en/docs/install/)
  - [bun](https://bun.sh/)
- OpenAI API Key (for the LangGraph agent)

## Getting Started

1. Install dependencies using your preferred package manager:

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

This will also install the Python agent dependencies via `uv sync`.

2. Set up your environment variables:

```bash
cp .env.example .env
```

Then edit the `.env` file and add your OpenAI API key:

```bash
OPENAI_API_KEY=your-openai-api-key-here
```

To enable OpenBox, also configure the CopilotKit and LangGraph credentials shown in `.env.example`. If those values are absent, the project runs as the standard CopilotKit + LangGraph starter.

3. Start the development server:

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

This will start both the UI and agent servers concurrently.

## OpenBox Integration

The demo has two independent OpenBox integration boundaries:

- `@openbox-ai/openbox-copilotkit` wraps the Next.js CopilotKit runtime. It observes CopilotKit requests, AG-UI messages, frontend tools, and human-in-the-loop surfaces. Frontend approval enforcement is disabled in this demo; the Python SDK is authoritative for backend enforcement.
- `openbox-langgraph-sdk-python` wraps LangGraph execution streams. It governs graph, LLM, backend tool, HTTP, database, and file activity according to the SDK configuration.

The Python graph is exposed as a generic AG-UI endpoint by `serve.py`, and the CopilotKit runtime connects to it with `HttpAgent`. A small graph proxy delegates state and schema operations to the original compiled graph while routing `ainvoke`, `astream`, and `astream_events` through the OpenBox handler.

Both wrappers are opt-in. The CopilotKit wrapper requires `OPENBOX_COPILOTKIT_API_KEY` and an OpenBox URL; the Python wrapper requires `OPENBOX_LANGGRAPH_API_KEY` and an OpenBox URL. Give each its agent's workload private key (`OPENBOX_COPILOTKIT_WORKLOAD_PRIVATE_KEY`, `OPENBOX_LANGGRAPH_WORKLOAD_PRIVATE_KEY`): the PEM shown when you create the agent (IAM v3 workload identity), kept inside double quotes in `.env`. Agents registered with a DID use the `*_AGENT_DID` / `*_AGENT_PRIVATE_KEY` variables instead. Each also falls back to the shared `OPENBOX_API_KEY` and `OPENBOX_WORKLOAD_PRIVATE_KEY` (or `OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY`) variables for simple single-agent testing.

The two SDKs emit separate `copilotkit` and `langgraph` workflow streams for one chat turn. This demo does not force them into one multi-agent session because the LangGraph agent is the backend implementation of the same assistant, not an explicit delegated subagent.

For local development, the CopilotKit SDK is installed from `file:../..` and the LangGraph SDK is installed as an editable dependency from `../../../../openbox-langgraph-sdk-python` relative to the `agent` directory.

## Available Scripts

The following scripts can also be run using your preferred package manager:

- `dev` - Starts both UI and agent servers in development mode
- `dev:debug` - Starts development servers with debug logging enabled
- `dev:ui` - Starts only the Next.js UI server
- `dev:agent` - Starts only the LangGraph agent server
- `build` - Builds the Next.js application for production
- `start` - Starts the production server
- `install:agent` - Installs Python dependencies for the agent

## Project Structure

```
├── src/                         # Next.js frontend source
│   ├── app/
│   │   ├── page.tsx             # Main page
│   │   └── api/copilotkit/      # CopilotKit API route
│   ├── components/
│   │   ├── example-canvas/      # Todo list UI
│   │   ├── example-layout/      # Layout: chat + canvas side-by-side
│   │   └── generative-ui/       # Example generative UI components
│   └── hooks/
├── agent/                       # LangGraph Python agent
│   ├── main.py                  # Agent entry point
│   └── src/
│       ├── todos.py             # Todo tools and state schema
│       └── query.py             # Example data query tool
├── scripts/                     # Agent setup and run scripts
│   ├── setup-agent.sh / .bat
│   └── run-agent.sh / .bat
├── public/                      # Static assets
├── next.config.ts
├── tsconfig.json
└── package.json
```

## A2UI — Agent-to-User Interface

This starter includes [A2UI](https://a2ui.org/specification/) support, allowing the agent to generate rich, interactive UI surfaces declaratively. Instead of returning plain text, the agent sends a JSON description of the UI it wants to render, and the frontend turns it into real components.

### How it works

A2UI uses three concepts:

1. **Catalog** — a set of component definitions (schema) paired with React renderers. Registered once in `layout.tsx` via `<CopilotKitProvider a2ui={{ catalog: demonstrationCatalog }}>`.
2. **Surface** — a rendered UI instance. The agent creates a surface, sets its components, and binds data to it.
3. **Operations** — the agent returns `a2ui.render(operations=[...])` from a tool, which the middleware streams to the frontend.

### Two patterns

| Pattern            | Description                                                                   | Agent tool       | Frontend                                    |
| ------------------ | ----------------------------------------------------------------------------- | ---------------- | ------------------------------------------- |
| **Fixed schema**   | Pre-defined component layout. Only the data changes per invocation.           | `search_flights` | Schema in `a2ui/schemas/flight_schema.json` |
| **Dynamic schema** | A secondary LLM generates both components and data based on the conversation. | `generate_a2ui`  | Components decided at runtime               |

Both patterns use the same catalog on the frontend — the difference is where the component tree comes from.

### Key files

| Purpose                              | Path                                               |
| ------------------------------------ | -------------------------------------------------- |
| Catalog definitions (Zod schemas)    | `src/app/declarative-generative-ui/definitions.ts` |
| Catalog renderers (React components) | `src/app/declarative-generative-ui/renderers.tsx`  |
| Catalog registration                 | `src/app/layout.tsx`                               |
| Fixed-schema agent tool              | `agent/src/a2ui_fixed_schema.py`                   |
| Dynamic-schema agent tool            | `agent/src/a2ui_dynamic_schema.py`                 |
| Flight schema JSON                   | `agent/src/a2ui/schemas/flight_schema.json`        |
| Showcase config                      | `showcase.json`                                    |

### Adding a custom component

1. **Define** the component schema in `definitions.ts`:

   ```typescript
   MyWidget: {
     description: "A brief description for the agent.",
     props: z.object({ title: z.string(), value: z.number() }),
   },
   ```

2. **Render** it in `renderers.tsx`:

   ```typescript
   MyWidget: ({ props }) => (
     <div>{props.title}: {props.value}</div>
   ),
   ```

   Renderers are type-checked against the definitions — TypeScript will error if props don't match.

3. **Use it** from the agent. The component is automatically available to both fixed-schema templates and the dynamic-schema LLM.

### Adding a new fixed-schema tool

1. Create a JSON schema file in `agent/src/a2ui/schemas/` describing the component tree.
2. Create a Python tool that loads the schema with `a2ui.load_schema()` and returns `a2ui.render(operations=[...])` with your data. See `a2ui_fixed_schema.py` for the pattern.

### Showcase mode

`showcase.json` controls which suggestion pills are visually highlighted. Set `"showcase": "a2ui"` to highlight the A2UI demos, or `"showcase": "default"` for no highlights. This is configured automatically when scaffolding via `npx copilotkit create --framework a2ui`.

### Further reading

- [A2UI Specification](https://a2ui.org/specification/)
- [CopilotKit A2UI Documentation](https://docs.copilotkit.ai)

## Documentation

- [LangGraph Documentation](https://langchain-ai.github.io/langgraph/) - Learn more about LangGraph and its features
- [CopilotKit Documentation](https://docs.copilotkit.ai) - Explore CopilotKit's capabilities

## Contributing

Feel free to submit issues and enhancement requests! This starter is designed to be easily extensible.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Troubleshooting

### Agent Connection Issues

If you see "I'm having trouble connecting to my tools", make sure:

1. The LangGraph AG-UI agent is running on port 8123
2. Your OpenAI API key is set correctly
3. Both servers started successfully

### Python Dependencies

If you encounter Python import errors:

```bash
npm run install:agent
```
