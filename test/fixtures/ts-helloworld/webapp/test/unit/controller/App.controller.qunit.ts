import QUnit from "sap/ui/thirdparty/qunit-2";
import App from "ui5/typescript/helloworld/controller/App.controller";

QUnit.module("App controller");

QUnit.test("onInit does not throw", (assert) => {
  const controller = new App();
  controller.onInit();
  assert.ok(controller, "controller instantiated");
});
