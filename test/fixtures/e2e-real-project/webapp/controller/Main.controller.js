sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/EventBus"
], function (Controller, EventBus) {
  "use strict";

  return Controller.extend("e2e.real.project.controller.Main", {

    onInit: function () {
      // SEEDED BREAK (missing-teardown):
      // Subscribes to the global EventBus channel "navigation" in onInit,
      // but there is no `onExit` method that unsubscribes. When the view
      // is destroyed the closure-captured handler is retained by the
      // EventBus, which is a real memory-leak pattern in SAPUI5 apps and
      // is what the `missing-teardown` check (SPEC §2.8 #3) looks for.
      var oBus = sap.ui.getCore().getEventBus();
      oBus.subscribe("navigation", "refresh", this._onNavigationRefresh, this);
    },

    _onNavigationRefresh: function (sChannel, sEvent, oData) {
      // Intentionally trivial — exists so the missing-teardown finding has
      // a real handler to point at.
      this._lastRefresh = oData;
    },

    onPress: function () {
      // SEEDED BREAK (no-direct-dom):
      // Uses `document.getElementById` to mutate a DOM node that belongs
      // to the rendered control. The idiomatic SAPUI5 path is
      // `this.byId(...)`. This violates SAPUI5 control-encapsulation and
      // is what the `no-direct-dom` check (SPEC §2.8 #1) looks for.
      var oNode = document.getElementById("__xmlview0--submitBtn");
      if (oNode) {
        oNode.setAttribute("data-pressed", "true");
      }
    },

    onLoadData: function () {
      // SEEDED BREAK (unhandled-promise-rejection):
      // Calls an async function but neither awaits it nor attaches a
      // `.catch` handler. If `_fetchData` rejects the rejection becomes
      // an "unhandled promise rejection" — a real pattern that survives
      // unit tests but crashes Node-style runtimes and bloats browser
      // console errors. SAPUI5 controllers commonly hit this through
      // event handlers (which cannot be `async` themselves without losing
      // the handler-context contract).
      this._fetchData();
    },

    _fetchData: async function () {
      var oResponse = await fetch("/api/items");
      if (!oResponse.ok) {
        throw new Error("Failed to load: " + oResponse.status);
      }
      var oData = await oResponse.json();
      this.getView().getModel().setProperty("/items", oData);
    }
  });
});
