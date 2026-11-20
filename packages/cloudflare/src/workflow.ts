import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { JobsTable } from "./d1.js";
import { STAGES, type Env, type ProductionParams, type Stage } from "./env.js";

/** Long stages get longer timeouts; every stage retries with backoff (stages are idempotent: outputs cached in R2). */
const STAGE_CONFIG: Record<Stage, { timeout: string; retries: number }> = {
  research: { timeout: "15 minutes", retries: 2 },
  script: { timeout: "10 minutes", retries: 2 },
  narration: { timeout: "20 minutes", retries: 2 },
  storyboard: { timeout: "15 minutes", retries: 2 },
  resolve: { timeout: "45 minutes", retries: 2 },
  manifest: { timeout: "10 minutes", retries: 2 },
  render: { timeout: "2 hours", retries: 1 },
  thumbnail: { timeout: "15 minutes", retries: 2 },
  qa: { timeout: "1 hour", retries: 1 },
};

interface StageResult {
  ok: boolean;
  stage: string;
  outputs: string[];
  verdict?: string;
  finalKey?: string;
  error?: string;
}

/**
 * One durable Workflow step per pipeline stage. Each step asks the job's renderer container to run that
 * stage (`produce --until <stage>`): the container pulls the job folder from R2, runs the stage (cached
 * stages are skipped), and pushes outputs back. Step results are small JSON so they persist cheaply.
 */
export class ProductionWorkflow extends WorkflowEntrypoint<Env, ProductionParams> {
  override async run(event: WorkflowEvent<ProductionParams>, step: WorkflowStep) {
    const p = event.payload;
    const jobs = new JobsTable(this.env.DB);
    await step.do("mark running", async () => {
      await jobs.update(p.jobId, { status: "running", workflow_id: event.instanceId });
      return true;
    });
    let last: StageResult | null = null;
    for (const stage of STAGES) {
      const cfg = STAGE_CONFIG[stage];
      last = await step.do(stage, { retries: { limit: cfg.retries, delay: "30 seconds", backoff: "exponential" }, timeout: cfg.timeout as never }, async () => {
        await jobs.update(p.jobId, { stage });
        const container = getContainer(this.env.RENDERER, p.jobId);
        const res = await container.fetch(
          new Request("http://renderer/stage", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.env.INTERNAL_TOKEN}` },
            body: JSON.stringify({ ...p, stage }),
          }),
        );
        const body = (await res.json()) as StageResult;
        if (!res.ok || !body.ok) throw new Error(`${stage} failed: ${body.error ?? res.status}`);
        return body;
      });
    }
    await step.do("mark done", async () => {
      await jobs.update(p.jobId, { status: last?.verdict === "fail" ? "failed" : "done", verdict: last?.verdict ?? null, final_key: last?.finalKey ?? null });
      return true;
    });
    return { jobId: p.jobId, verdict: last?.verdict ?? null, finalKey: last?.finalKey ?? null };
  }
}
