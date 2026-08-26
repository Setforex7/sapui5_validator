import Controller from "sap/ui/core/mvc/Controller";

/**
 * A second, intentionally UNCOVERED controller — there is deliberately NO
 * matching `webapp/test/unit/controller/Detail.controller.qunit.ts`. It exists
 * so the VALIDATOR_E2E_REAL generate-for-TS witness
 * (test/e2e-real/ts-generate.e2e.test.ts) has a discovery target: the fixture's
 * `App.controller.ts` is already covered, so a `generate` run would otherwise
 * find nothing to do.
 *
 * `formatGreeting` is a pure, side-effect-free method (no UI5 runtime needed),
 * so a generated `.qunit.ts` can assert concrete behaviour against it and pass
 * the static-only shape gate (`checkTsTestShape`) under standalone
 * `tsc --noEmit`. The class stays type-clean (imports only `Controller`) so the
 * generate baseline lint guard does not refuse before generation.
 *
 * @namespace e2e.real.ts.controller
 */
export default class Detail extends Controller {
  public onInit(): void {
    /* noop */
  }

  public formatGreeting(name: string): string {
    const trimmed = name.trim();
    return trimmed.length > 0 ? `Hello, ${trimmed}!` : "Hello, World!";
  }
}
