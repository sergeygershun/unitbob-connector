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
  surfaceOutputPath,
  surfacesPath,
  writeMapBuildRequest,
} from '../src/files/mapBuild.ts';

const RECIPES = {
  decompose: { name: 'decompose', version: 'd1', text: 'decompose recipe' },
  relate: { name: 'relate', version: 'r1', text: 'relate recipe' },
  extract_surfaces: { name: 'extract_surfaces', version: 'e1', text: 'extract recipe' },
  decompose_surfaces: { name: 'decompose_surfaces', version: 's1', text: 'group recipe' },
};

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-map-build-files-'));
}

test('reads the fresh graph and writes the map build request packet', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');

  const rawGraph = readFreshGraph(projectRoot);
  const packet = writeMapBuildRequest(projectRoot, RECIPES);

  assert.equal(rawGraph, '{ "nodes": [] }\n');
  assert.equal(packet.graph_path, graphPath(projectRoot));
  assert.equal(packet.output_path, outputPath(projectRoot));
  assert.equal(packet.surfaces_path, surfacesPath(projectRoot));
  assert.equal(packet.surface_output_path, surfaceOutputPath(projectRoot));
  assert.equal(packet.recipes.extract_surfaces.text, 'extract recipe');
  assert.equal(packet.recipes.decompose_surfaces.text, 'group recipe');
  assert.equal(existsSync(requestPath(projectRoot)), true);
  assert.deepEqual(readMapBuildRequest(projectRoot), packet);
});

test('rejects invalid graph or host output JSON', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
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
