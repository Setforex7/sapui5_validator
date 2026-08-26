import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  scaffoldTestLayout,
  TEMPLATE_CHOICES,
  type TemplateChoice,
} from '../../src/generation/templates/index.js';
import { detectDiscoveryMode } from '../../src/generation/registration.js';

describe('scaffoldTestLayout', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sapui5-tmpl-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('creates testsuite + unit + integration entry files', async () => {
    const result = await scaffoldTestLayout({
      projectRoot: root,
      namespace: 'demo.app',
      choice: 'sap.m',
    });
    expect(result.choice).toBe('sap.m');
    expect(result.files.length).toBe(5);
    expect(existsSync(join(root, 'webapp', 'test', 'testsuite.qunit.html'))).toBe(true);
    expect(existsSync(join(root, 'webapp', 'test', 'unit', 'unit.qunit.html'))).toBe(true);
    expect(existsSync(join(root, 'webapp', 'test', 'unit', 'unit.qunit.js'))).toBe(true);
    expect(
      existsSync(join(root, 'webapp', 'test', 'integration', 'opaTests.qunit.html')),
    ).toBe(true);
    expect(
      existsSync(join(root, 'webapp', 'test', 'integration', 'AllJourneys.js')),
    ).toBe(true);
  });

  test('embeds the namespace into the suite + OPA5 scaffolding', async () => {
    await scaffoldTestLayout({ projectRoot: root, namespace: 'acme.foo', choice: 'sap.f' });
    const testsuite = readFileSync(
      join(root, 'webapp', 'test', 'testsuite.qunit.html'),
      'utf8',
    );
    expect(testsuite).toContain('QUnit test suite for acme.foo');
    const allJourneys = readFileSync(
      join(root, 'webapp', 'test', 'integration', 'AllJourneys.js'),
      'utf8',
    );
    expect(allJourneys).toContain('viewNamespace: "acme.foo.view."');
  });

  test('scaffolds a sap.ui.require testsuite.qunit.html registration can detect', async () => {
    await scaffoldTestLayout({ projectRoot: root, namespace: 'demo.app', choice: 'sap.m' });
    const testsuite = readFileSync(
      join(root, 'webapp', 'test', 'testsuite.qunit.html'),
      'utf8',
    );
    // V1.3-4: the scaffolded suite uses the karma-ui5 html-mode discovery
    // format `generate` parses and writes, so a fresh project is
    // self-consistent with the registration logic.
    expect(testsuite).toContain('sap.ui.require([');
    expect(testsuite).toContain('demo/app/test/unit/unit.qunit');
    expect(detectDiscoveryMode(root)).toBe('testsuite-require');
  });

  test('TEMPLATE_CHOICES exposes all three SPEC §2.4 choices', () => {
    expect(TEMPLATE_CHOICES).toEqual<readonly TemplateChoice[]>([
      'sap.m',
      'sap.f',
      'fiori-elements',
    ]);
  });
});
