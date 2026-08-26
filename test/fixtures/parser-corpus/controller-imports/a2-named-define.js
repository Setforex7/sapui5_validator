// Corpus: V1.5 #A2 — KNOWN LIMITATION (OPEN). The named
// `sap.ui.define("id", [...])` form is missed by the head regex
// /sap\.ui\.define\s*\(\s*\[/, so the real imports are silently dropped.
// The spec pins the CURRENT [] result; fixing #A2 must flip that pin.
sap.ui.define("corpus/a2/controller/Foo", ["dep/a"], function (A) {
  "use strict";
  return {};
});
