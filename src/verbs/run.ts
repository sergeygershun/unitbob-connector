// `unitbob run` — the end-to-end check. It will: GET the suite blob, materialize
// it locally, spawn `rspec --format json`, POST the *raw* output to the server,
// and print the run summary the server returns. The connector must never parse
// that output into pass/fail — Rails owns interpretation (spec 15, decision #4).
//
// Wired entry point in the skeleton; the capability body lands in spec 18
// (Suite Run on Connector).
import type { Config } from '../config.ts';

export async function run(_config: Config, _args: string[]): Promise<void> {
  process.stdout.write(
    'unitbob run: not implemented yet — arrives in spec 18 (Suite Run on Connector).\n',
  );
}
