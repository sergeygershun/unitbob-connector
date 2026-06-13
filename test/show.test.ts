import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapUrl } from '../src/verbs/show.ts';

test('mapUrl builds the map link from config', () => {
  assert.equal(mapUrl({ server: 'https://host', repoId: 3, projectRoot: '/project' }), 'https://host/repos/3/map');
});
