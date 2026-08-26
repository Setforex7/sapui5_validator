sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";

  return Controller.extend("minimal.project.controller.Main", {

    onInit: function () {
      // SEEDED BREAK (no-direct-dom): use of document.getElementById
      // instead of this.byId(...). Should be flagged by check #1.
      var node = document.getElementById("app");
      if (node) {
        node.setAttribute("data-ready", "true");
      }
    },

    onSubmitPress: function () {
      // Intentionally empty — view binds Submit button to this handler.
    }
  });
});
