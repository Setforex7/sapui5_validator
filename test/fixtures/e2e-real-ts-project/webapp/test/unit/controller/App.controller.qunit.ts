import QUnit from "sap/ui/thirdparty/qunit-2";
import App from "e2e/real/ts/controller/App.controller";

QUnit.module("App controller");

QUnit.test("onInit does not throw", (assert) => {
  // `sap/ui/core/mvc/Controller`'s constructor requires the controller name
  // (so this type-checks under standalone `tsc --noEmit` against @openui5/types).
  const controller = new App("App");
  controller.onInit();
  assert.ok(controller, "controller instantiated");
});
