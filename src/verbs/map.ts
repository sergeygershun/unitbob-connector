import type { Config } from '../config.ts';
import { analyze } from './analyze.ts';

export async function map(config: Config, args: string[]): Promise<void> {
  await analyze(config, args);
}
