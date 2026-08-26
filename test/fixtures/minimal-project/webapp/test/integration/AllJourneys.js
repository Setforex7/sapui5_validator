sap.ui.define([
  "sap/ui/test/Opa5"
], function (Opa5) {
  "use strict";

  Opa5.extendConfig({
    arrangements: new Opa5(),
    viewNamespace: "minimal.project.view.",
    autoWait: true
  });

  // Journeys would be required here in a full project. Empty in the
  // fixture so layout detection has something to find without making
  // karma actually run anything.
});
