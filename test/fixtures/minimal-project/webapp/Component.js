sap.ui.define([
  "sap/ui/core/UIComponent"
], function (UIComponent) {
  "use strict";

  return UIComponent.extend("minimal.project.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      // NOTE: deliberately does not initialise routing for the `details`
      // route declared in manifest.json — this drift is the seeded
      // `manifest-component-drift` finding (see fixture README).
    }
  });
});
