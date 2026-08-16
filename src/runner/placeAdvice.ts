// What to say when this project's test toolchain cannot be started (spec 36, §7).
//
// Half the value of the whole spec is here rather than in the adapter. A field
// nobody discovers is a field nobody sets: the vibecoder whose gems live only
// inside a container reads "Bundler failed to provision rspec-rails under
// .unitbob/runners." — a sentence about a symptom, which sounds like "your
// project is broken" and sends them off inventing workarounds.
//
// Two situations, one question, so they live in one function: the place is not
// configured and something on this machine looks like the answer, or the place
// is configured and the advice above just told somebody to run a command in the
// wrong place.
import { containersHolding } from './docker.ts';
import { placeOf } from './place.ts';

// The sentence to add to a message that has already decided to stop, or null
// when there is nothing worth saying.
//
// Only ever called on the failure path. On a successful run `docker` is not
// asked anything, so nobody without Docker pays for this and nobody with Docker
// waits for it.
export function placeAdvice(projectRoot: string): string | null {
  const place = placeOf(projectRoot);

  // Already running in a container. Then the problem is not "which place" — it
  // is that every manual command above (`bundle install`, `npm install --prefix
  // .unitbob/runners`, `gem install bundler`, "activate your virtualenv") reads
  // as "do this in your project folder", and doing it here would change nothing.
  // One sentence covers all of them, and none of them has to be rewritten.
  if (place.kind === 'docker') {
    return (
      `This project's tests run inside the container \`${place.container}\`, so any command suggested above ` +
      `has to be run in there, not here: \`docker exec -it ${place.container} <command>\`.`
    );
  }

  const candidates = containersHolding(projectRoot);
  if (candidates.length === 0) return null;

  const lines = candidates.map(
    (found) =>
      `  \`${found.name}\` — it sees this project as \`${found.projectRoot}\`\n` +
      `      "exec": {"docker": {"container": ${JSON.stringify(found.name)}}}`,
  );

  // Several candidates are listed and none is picked. Guessing between `web` and
  // `worker` is wrong on the first project that has both, and a wrong guess here
  // is silent: the suite runs somewhere nobody meant it to.
  return (
    "This project's tests do not run on this machine, and they may not be meant to. " +
    `${candidates.length === 1 ? 'A running container already has this project mounted' : 'These running containers already have this project mounted'}` +
    `:\n\n${lines.join('\n')}\n\n` +
    `Add the line under the container you run your tests in to \`.unitbob.json\`, then run this again.`
  );
}
