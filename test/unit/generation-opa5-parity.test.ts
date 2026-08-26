/**
 * R2.5 witnesses (AUDIT §5.7c) — OPA5 quarantine containment parity.
 *
 * Pre-R2.5, `generateOpa5Journey` passed no `unregister` into the retry
 * loop, so a quarantined journey never fired `ensureFailingExcluded`: on a
 * glob-auto project the broad karma `files:` glob re-collected the
 * quarantined `*Journey.qunit.js` from `webapp/test/_failing/` on the next
 * run and poisoned its baseline (`baseline-failed`). These tests drive
 * `generateOpa5Journey` end-to-end with a fake runner and a failing verify
 * and pin the containment: reverting the unregister threading in
 * `opa5.ts` turns the first test red.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CallBudget } from '../../src/claude/budget.js';
import { FakeClaudeRunner } from '../../src/claude/fake-runner.js';
import { generateOpa5Journey } from '../../src/generation/opa5.js';
import type { DiscoveryMode } from '../../src/generation/registration.js';
import type { VerifyResult } from '../../src/verify/pipeline.js';

const KARMA_CONF = [
  'module.exports = function (config) {',
  "  config.set({",
  "    frameworks: ['ui5'],",
  '    files: [',
  "      'webapp/test/**/*.qunit.js',",
  '    ],',
  '  });',
  '};',
  '',
].join('\n');

const VIEW_XML = [
  '<mvc:View controllerName="demo.app.controller.Main" xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc">',
  '  <Page id="page" />',
  '</mvc:View>',
  '',
].join('\n');

const CONTROLLER_JS = [
  'sap.ui.define(["sap/ui/core/mvc/Controller"], function (Controller) {',
  '  "use strict";',
  '  return Controller.extend("demo.app.controller.Main", {});',
  '});',
  '',
].join('\n');

function failingVerify(): VerifyResult {
  return {
    ok: false,
    steps: [],
    failedStep: 'karma',
    feedbackForLlm: 'OPA5 journey failed verification',
  };
}

describe('generateOpa5Journey — R2.5 quarantine containment parity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-opa5-parity-'));
    mkdirSync(join(root, 'webapp', 'view'), { recursive: true });
    mkdirSync(join(root, 'webapp', 'controller'), { recursive: true });
    mkdirSync(join(root, 'webapp', 'test', 'integration'), { recursive: true });
    writeFileSync(join(root, 'karma.conf.js'), KARMA_CONF, 'utf8');
    writeFileSync(join(root, 'webapp', 'view', 'Main.view.xml'), VIEW_XML, 'utf8');
    writeFileSync(
      join(root, 'webapp', 'controller', 'Main.controller.js'),
      CONTROLLER_JS,
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function runJourney(discoveryMode: DiscoveryMode) {
    const journeyRel = 'webapp/test/integration/MainJourney.qunit.js';
    const runner = new FakeClaudeRunner([
      {
        match: /./,
        response: { raw: JSON.stringify({ newFileContent: '// broken journey\n' }) },
      },
    ]);
    return generateOpa5Journey({
      candidate: {
        viewAbs: join(root, 'webapp', 'view', 'Main.view.xml'),
        viewRel: 'webapp/view/Main.view.xml',
        controllerAbs: join(root, 'webapp', 'controller', 'Main.controller.js'),
        controllerRel: 'webapp/controller/Main.controller.js',
        viewName: 'Main',
        journeyTestAbs: join(root, journeyRel),
        journeyTestRel: journeyRel,
      },
      projectRoot: root,
      runner,
      budget: new CallBudget({ maxCalls: 10 }),
      eslintEnabled: false,
      verifyFn: async () => failingVerify(),
      namespace: 'demo.app',
      discoveryMode,
    });
  }

  test('glob-auto: a quarantined journey injects the karma exclude for _failing/ (baseline no longer poisoned)', async () => {
    const outcome = await runJourney('glob-auto');
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind === 'quarantined') {
      expect(outcome.quarantinedAtRel).toBe(
        'webapp/test/_failing/MainJourney.failing.qunit.js',
      );
    }
    // The journey moved under _failing/ ...
    expect(
      existsSync(join(root, 'webapp', 'test', '_failing', 'MainJourney.failing.qunit.js')),
    ).toBe(true);
    expect(existsSync(join(root, 'webapp', 'test', 'integration', 'MainJourney.qunit.js'))).toBe(
      false,
    );
    // ... AND the broad files: glob can no longer re-collect it: the
    // unregister threading (R2.5) fired ensureFailingExcluded.
    const karmaConf = readFileSync(join(root, 'karma.conf.js'), 'utf8');
    expect(karmaConf).toContain('**/test/_failing/**');
  });

  test('testsuite-require: the unregister is an idempotent no-op (no exclude injected, karma.conf untouched)', async () => {
    const outcome = await runJourney('testsuite-require');
    expect(outcome.kind).toBe('quarantined');
    // The exclude is glob-auto-scoped: in testsuite-require the journey was
    // never in the discovery array, so nothing needs excluding and the
    // user's karma config is not touched.
    const karmaConf = readFileSync(join(root, 'karma.conf.js'), 'utf8');
    expect(karmaConf).toBe(KARMA_CONF);
  });
});
