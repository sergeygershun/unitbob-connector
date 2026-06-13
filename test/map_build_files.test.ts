import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  graphPath,
  outputPath,
  readFreshGraph,
  readHostMapOutput,
  readMapBuildRequest,
  requestPath,
  writeMapBuildRequest,
} from '../src/files/mapBuild.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-map-build-files-'));
}

test('reads the fresh graph and writes the map build request packet', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'graphify-out'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');

  const rawGraph = readFreshGraph(projectRoot);
  const packet = writeMapBuildRequest(projectRoot, {
    decompose: { name: 'decompose', version: 'd1', text: 'decompose recipe' },
    relate: { name: 'relate', version: 'r1', text: 'relate recipe' },
  });

  assert.equal(rawGraph, '{ "nodes": [] }\n');
  assert.equal(packet.graph_path, graphPath(projectRoot));
  assert.equal(packet.output_path, outputPath(projectRoot));
  assert.equal(existsSync(requestPath(projectRoot)), true);
  assert.deepEqual(readMapBuildRequest(projectRoot), packet);
});

test('rejects invalid graph or host output JSON', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'graphify-out'), { recursive: true });
  writeFileSync(graphPath(projectRoot), 'not json');

  assert.throws(() => readFreshGraph(projectRoot), /graph\.json is not valid JSON/);

  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(outputPath(projectRoot), 'not json');
  assert.throws(() => readHostMapOutput(outputPath(projectRoot)), /map_document\.json is not valid JSON/);
});

test('reads parseable host map output without changing it', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');

  assert.deepEqual(readHostMapOutput(outputPath(projectRoot)), { version: 3 });
  assert.equal(readFileSync(outputPath(projectRoot), 'utf8'), '{ "version": 3 }\n');
});
