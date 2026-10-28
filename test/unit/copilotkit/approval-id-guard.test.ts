import {
  ActivityContext,
  ApprovalRejectedError,
  ApprovalResult,
  EvaluationResult,
  Verdict
} from "@openbox-ai/openbox-sdk-ts";
import { describe, expect, it, vi } from "vitest";

import {
  acceptOnlyAwaitedApproval,
  AwaitedApprovalAdapter
} from "../../../src/copilotkit/internal/approval-id-guard.js";

import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";

function decision(approvalId: string | null, action: string): ApprovalResult {
  return ApprovalResult.fromDict({ ...(approvalId ? { id: approvalId } : {}), action });
}

function requireApproval(governanceEventId: string): EvaluationResult {
  const result = new EvaluationResult();
  result.verdict = Verdict.REQUIRE_APPROVAL;
  result.governanceEventId = governanceEventId;
  return result;
}

const CONTEXT = new ActivityContext({ activityId: "act-1", runId: "run-1", workflowId: "wf-1" });

/** A client whose approval polls answer from `answers`, in order. */
function clientAnswering(...answers: ApprovalResult[]): OpenBoxClient {
  const pollApproval = vi.fn(() => Promise.resolve(answers.shift() ?? null));
  return { pollApproval } as unknown as OpenBoxClient;
}

describe("acceptOnlyAwaitedApproval", () => {
  it("keeps a decision for the awaited approval", () => {
    const approved = decision("approval-current", "allow");
    expect(acceptOnlyAwaitedApproval(approved, "approval-current")).toBe(approved);
  });

  it("turns a decision for another approval into a rejection", () => {
    const answer = acceptOnlyAwaitedApproval(decision("approval-older", "allow"), "approval-current");
    expect(answer?.allowShaped).toBe(false);
    expect(answer?.isPending()).toBe(false);
    expect(answer?.reason).toContain("approval-older");
  });

  it("leaves a pending answer pending, whatever its id", () => {
    const pending = decision("approval-older", "require_approval");
    expect(acceptOnlyAwaitedApproval(pending, "approval-current")).toBe(pending);
  });

  it("does not treat an answer without an id as a mismatch", () => {
    const approved = decision(null, "allow");
    expect(acceptOnlyAwaitedApproval(approved, "approval-current")).toBe(approved);
  });
});

describe("AwaitedApprovalAdapter", () => {
  it("proceeds when the awaited approval is approved", async () => {
    const adapter = new AwaitedApprovalAdapter(
      clientAnswering(decision("approval-current", "require_approval"), decision("approval-current", "allow")),
      { pollIntervalMs: 1 }
    );
    await expect(adapter.handleApproval(requireApproval("approval-current"), CONTEXT)).resolves.toBeUndefined();
  });

  it("rejects when Core answers with an older approval of the same activity", async () => {
    const adapter = new AwaitedApprovalAdapter(
      clientAnswering(decision("approval-current", "require_approval"), decision("approval-older", "allow")),
      { pollIntervalMs: 1 }
    );
    await expect(adapter.handleApproval(requireApproval("approval-current"), CONTEXT)).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
  });
});
