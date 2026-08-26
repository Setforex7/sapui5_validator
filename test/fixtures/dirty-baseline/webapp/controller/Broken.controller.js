sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("dirty.baseline.controller.Broken", {

    onInit: function () {
      // SEEDED BREAKS for the dirty-baseline fixture:
      //  1. `unused` is declared but never read       (eslint: no-unused-vars)
      //  2. `notDefined` is referenced without import (eslint: no-undef)
      //  3. `var` rather than `let`/`const`           (ui5lint stylistic)
      var unused = 42;
      var label = notDefined.toString();
      this.byId("title").setText(label);
    }
  });
});
