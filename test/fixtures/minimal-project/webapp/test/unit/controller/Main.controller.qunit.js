sap.ui.define([
  "minimal/project/controller/Main.controller"
], function (MainController) {
  "use strict";

  QUnit.module("controller.Main");

  QUnit.test("module loads", function (assert) {
    assert.ok(MainController, "Main controller module loads");
  });
});
