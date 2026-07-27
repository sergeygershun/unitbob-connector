#!/usr/bin/env node
// The published executable (`package.json` bin). It exists only to start the
// process and end it: no logic lives here, so nothing about how the CLI was
// invoked can change what it does. npm installs a bin as a symlink, so this file
// runs under a path that is not its own — an entry point that tried to detect
// "am I the main module?" silently did nothing once installed.
import { main } from './cli.ts';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  },
);
