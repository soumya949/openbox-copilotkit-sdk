import { ApprovalResult, Verdict } from "@openbox-ai/openbox-sdk-ts";
import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { ApprovalPoller, type ApprovalPollerOptions } from "@openbox-ai/openbox-sdk-ts/approvals";
import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";

import type { ActivityContext, EvaluationResult } from "@openbox-ai/openbox-sdk-ts";

/**
 * Accept a polled decision only for the approval being waited on.
 *
 * Core keys approval polls on (workflow_id, run_id, activity_id), which two
 * approvals of one activity share. Once the newer approval is decided, Core
 * can answer with the older one; acting on that turns a rejection into an
 * approval. So a final decision for any other approval becomes a rejection,
 * while a pending answer — which decides nothing — keeps the wait going.
 * Unknown ids on either side are not treated as a mismatch.
 */
export function acceptOnlyAwaitedApproval(
  approval: ApprovalResult | null,
  awaitedApprovalId: string
): ApprovalResult | null {
  if (
    approval === null ||
    approval.isPending() ||
    !approval.approvalId ||
    approval.approvalId === awaitedApprovalId
  ) {
    return approval;
  }
  const mismatch = new ApprovalResult();
  mismatch.verdict = Verdict.BLOCK;
  mismatch.approvalId = approval.approvalId;
  mismatch.reason = `OpenBox returned the decision for approval ${approval.approvalId} instead of ${awaitedApprovalId}`;
  return mismatch;
}

/** `client`, with every approval poll checked against `awaitedApprovalId`. */
function guardedClient(client: OpenBoxClient, awaitedApprovalId: string): OpenBoxClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "pollApproval") {
        return async (...args: Parameters<OpenBoxClient["pollApproval"]>) =>
          acceptOnlyAwaitedApproval(await target.pollApproval(...args), awaitedApprovalId);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    }
  });
}

/**
 * The base `CoreAdapter`, with each approval wait bound to the approval Core
 * opened for that decision (`approval_id`, else `governance_event_id`).
 */
export class AwaitedApprovalAdapter extends CoreAdapter {
  readonly #client: OpenBoxClient;
  readonly #pollerOptions: ApprovalPollerOptions;

  constructor(client: OpenBoxClient, pollerOptions: ApprovalPollerOptions) {
    super({ approvalPoller: new ApprovalPoller(client, pollerOptions) });
    this.#client = client;
    this.#pollerOptions = pollerOptions;
  }

  override async handleApproval(result: EvaluationResult, context?: ActivityContext | null): Promise<void> {
    const awaitedApprovalId = result.approvalId ?? result.governanceEventId;
    if (!awaitedApprovalId) {
      return super.handleApproval(result, context);
    }
    const poller = new ApprovalPoller(guardedClient(this.#client, awaitedApprovalId), this.#pollerOptions);
    return new CoreAdapter({ approvalPoller: poller }).handleApproval(result, context);
  }
}
