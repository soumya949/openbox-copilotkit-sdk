"""Serve the LangGraph agent through AG-UI with optional OpenBox governance."""

import os
import sys
from pathlib import Path
from typing import Any

# Add the agent directory to the path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "agent"))

import uvicorn
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langgraph.checkpoint.memory import MemorySaver
from openbox_langgraph import OpenBoxLangGraphHandler, create_openbox_graph_handler

load_dotenv(Path(__file__).with_name(".env"))

# Import the original compiled graph.
from main import graph as compiled_graph

# The create_agent() graph may not have a checkpointer (it's normally
# provided by the LangGraph Platform server). Add one for standalone serving.
if not hasattr(compiled_graph, "checkpointer") or compiled_graph.checkpointer is None:
    # Recompile with a checkpointer
    compiled_graph = compiled_graph.copy()
    compiled_graph.checkpointer = MemorySaver()


class GovernedGraphProxy:
    """Keep CompiledStateGraph APIs while governing its execution streams."""

    def __init__(self, graph: Any, handler: OpenBoxLangGraphHandler) -> None:
        self._graph = graph
        self._handler = handler

    def __getattr__(self, name: str) -> Any:
        return getattr(self._graph, name)

    async def ainvoke(
        self,
        input: dict[str, Any],
        config: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return await self._handler.ainvoke(input, config=config, **kwargs)

    def astream(
        self,
        input: dict[str, Any],
        config: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        return self._handler.astream(input, config=config, **kwargs)

    def astream_events(
        self,
        input: dict[str, Any],
        config: dict[str, Any] | None = None,
        *,
        version: str = "v2",
        **kwargs: Any,
    ) -> Any:
        return self._handler.astream_events(
            input,
            config=config,
            version=version,
            **kwargs,
        )


def env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def create_served_graph(graph: Any) -> Any:
    api_url = os.getenv("OPENBOX_LANGGRAPH_API_URL") or os.getenv("OPENBOX_URL")
    api_key = os.getenv("OPENBOX_LANGGRAPH_API_KEY") or os.getenv("OPENBOX_API_KEY")

    if not api_url or not api_key:
        return graph

    handler = create_openbox_graph_handler(
        graph,
        api_url=api_url,
        api_key=api_key,
        agent_did=os.getenv("OPENBOX_LANGGRAPH_AGENT_DID")
        or os.getenv("OPENBOX_AGENT_DID"),
        agent_private_key=os.getenv("OPENBOX_LANGGRAPH_AGENT_PRIVATE_KEY")
        or os.getenv("OPENBOX_AGENT_PRIVATE_KEY"),
        workload_private_key=os.getenv("OPENBOX_LANGGRAPH_WORKLOAD_PRIVATE_KEY")
        or os.getenv("OPENBOX_WORKLOAD_PRIVATE_KEY"),
        agent_name="langgraph-python-demo",
        task_queue="langgraph",
        validate=env_flag("OPENBOX_LANGGRAPH_VALIDATE", True),
    )
    return GovernedGraphProxy(graph, handler)


served_graph = create_served_graph(compiled_graph)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=LangGraphAGUIAgent(
        name="sample_agent",
        description="LangGraph Python starter agent",
        graph=served_graph,
    ),
    path="/",
)

if __name__ == "__main__":
    port = int(os.getenv("AGENT_PORT", "8123"))
    uvicorn.run(app, host="0.0.0.0", port=port)
