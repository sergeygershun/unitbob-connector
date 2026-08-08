import type { Config } from '../config.ts';
import { validateWorkerPlanFiles, workerPlanDigest } from '../files/workerPlan.ts';

export async function validateWorkerPlan(
  config: Config,
  _args: string[] = [],
  deps: { stdout: { write: (chunk: string) => unknown } } = { stdout: process.stdout },
): Promise<{ plan_digest: string }> {
  const errors = validateWorkerPlanFiles(config.projectRoot);
  if (errors.length > 0) throw new Error(`Worker plan is invalid:\n- ${errors.join('\n- ')}`);
  const planDigest = workerPlanDigest(config.projectRoot);
  deps.stdout.write(`Worker plan valid (${planDigest}). Fan-out may start.\n`);
  return { plan_digest: planDigest };
}
