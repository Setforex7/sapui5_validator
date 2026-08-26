/**
 * Corpus: V1.4-11 incident — a commented-out / JSDoc-@example
 * `sap.ui.define([...])` above the live one must NOT hijack the parse.
 * @example
 * sap.ui.define(["sap/evil/Thing"], function () {});
 */
// sap.ui.define(["sap/ui/export/Spreadsheet"], function () {});
sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/Button"
], function (Controller, Button) {
  "use strict";
  return Controller.extend("corpus.v1411.Main", {});
});
