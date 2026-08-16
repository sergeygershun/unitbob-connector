import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcResult } from '../proc.ts';
import { BEHAVIORAL_WORLD_PATH } from '../files/behavioral.ts';
import { projectRootAsSeenByThePlace, runInProject } from './place.ts';
import { PROVISION_TIMEOUT_MS } from './provision.ts';

export interface WorldProbeResult {
  status: 'ok' | 'fixable';
  message?: string;
}

interface WorldProbeDeps {
  runCmd: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<ProcResult>;
}

const PROBE_ROOT = '.unitbob/suite-build/world-probe';

export async function probeBehavioralWorld(
  projectRoot: string,
  deps: WorldProbeDeps = {
    runCmd: (command, args, options) =>
      runInProject(options.cwd, command, args, { env: options.env, timeoutMs: PROVISION_TIMEOUT_MS }),
  },
): Promise<WorldProbeResult> {
  // Written on the host, named to the run relative to the project root — the
  // same shape `bdd.ts` has always had, and the reason nothing here needs a path
  // rewritten when the run happens somewhere else (spec 36, §4.2).
  const feature = `${PROBE_ROOT}/world.feature`;
  const steps = `${PROBE_ROOT}/world_steps.rb`;
  const probeRoot = join(projectRoot, PROBE_ROOT);
  mkdirSync(probeRoot, { recursive: true });
  writeFileSync(join(projectRoot, feature), PROBE_FEATURE);
  writeFileSync(join(projectRoot, steps), PROBE_STEPS);

  try {
    const result = await deps.runCmd('bundle', [
      'exec', 'cucumber', feature,
      '--require', BEHAVIORAL_WORLD_PATH,
      '--require', steps,
      '--format', 'progress',
    ], {
      cwd: projectRoot,
      env: {
        RAILS_ENV: 'test',
        CUCUMBER_PUBLISH_QUIET: 'true',
        UNITBOB_REPO_ROOT: await projectRootAsSeenByThePlace(projectRoot),
        BUNDLE_GEMFILE: '.unitbob/behavioral/Gemfile',
      },
    });
    if (result.code === 0) return { status: 'ok' };
    const detail = [result.stdout, result.stderr].map((text) => text.trim()).filter(Boolean).join('\n') || `exit ${result.code}`;
    return { status: 'fixable', message: `The connector-owned Ruby/Cucumber World probe failed: ${detail}` };
  } catch (error) {
    return { status: 'fixable', message: `The connector-owned Ruby/Cucumber World probe could not run: ${String(error)}` };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const PROBE_FEATURE = `Feature: Unitbob World profile
  Scenario: request, assertion counter, mocks, and state mutation
    Given the first World probe scenario mutates supported state
    Then its integration assertion counter advances

  Scenario: supported state is clean at the next scenario boundary
    Then the second World probe scenario sees clean state and fresh mocks

  Scenario: outgoing HTTP does not leave the machine
    Then the World probe cannot reach the network
`;

const PROBE_STEPS = `PROBE_VERSION = "unitbob-world-probe-#{Process.pid}"
PROBE_TIME_ZONE = Time.zone
PROBE_OTHER_TIME_ZONE = PROBE_TIME_ZONE&.name == 'UTC' ? 'Hawaii' : 'UTC'
PROBE_LOCALE = I18n.locale
PROBE_RECEIVER = Object.new

# The probe runs in a dedicated process, so replacing its in-memory route set
# cannot affect the host application after the process exits. Keeping these
# endpoints here makes the profile check independent of routes the host owns.
Rails.application.routes.draw do
  match '/__unitbob_world_probe__', to: proc { [200, { 'Content-Type' => 'text/plain' }, ['ok']] }, via: :all
  match '/__unitbob_world_probe_redirect__', to: redirect('/__unitbob_world_probe_target__'), via: :all
end

Given('the first World probe scenario mutates supported state') do
  @unitbob_connection.execute("INSERT INTO schema_migrations (version) VALUES ('#{PROBE_VERSION}')")
  Time.zone = PROBE_OTHER_TIME_ZONE
  alternate_locale = (I18n.available_locales - [PROBE_LOCALE]).first
  I18n.locale = alternate_locale if alternate_locale
  expect(PROBE_RECEIVER).to receive(:unitbob_probe).once.and_return(:mocked)
  expect(PROBE_RECEIVER.unitbob_probe).to eq(:mocked)
  unitbob_get('/__unitbob_world_probe__')
  unitbob_expect_status(:success)
  unitbob_get('/__unitbob_world_probe_redirect__')
  unitbob_expect_redirect_to('/__unitbob_world_probe_target__')
end

Then('its integration assertion counter advances') do
  expect(unitbob_session.assertions).to be > 0
end

# Spec 35-1, criterion 2. Checked here rather than trusted, because the failure
# it guards against is invisible from inside: a suite whose WebMock never came on
# passes exactly the same way, and only the other end of the wire ever finds out.
Then('the World probe cannot reach the network') do
  require 'net/http'
  expect {
    Net::HTTP.get(URI('http://unitbob-world-probe.invalid/'))
  }.to raise_error(WebMock::NetConnectNotAllowedError)
end

Then('the second World probe scenario sees clean state and fresh mocks') do
  quoted = @unitbob_connection.quote(PROBE_VERSION)
  count = @unitbob_connection.select_value("SELECT COUNT(*) FROM schema_migrations WHERE version = #{quoted}").to_i
  expect(count).to eq(0)
  expect(Time.zone).to eq(PROBE_TIME_ZONE)
  expect(I18n.locale).to eq(PROBE_LOCALE)
  expect(PROBE_RECEIVER).not_to respond_to(:unitbob_probe)
  probe = double('fresh-world-probe')
  expect(probe).to receive(:call).once
  probe.call
end
`;
