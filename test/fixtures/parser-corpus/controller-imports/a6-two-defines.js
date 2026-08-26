// Corpus: V1.5 #A6 — pinned truncation. Two array-form defines in one file;
// only the FIRST define's import array is parsed (multi-define support is an
// undecided product question — the pin makes any change a deliberate one).
sap.ui.define(["sap/m/Button"], function (Button) {
  "use strict";
});
sap.ui.define(["sap/ui/export/Spreadsheet"], function (S) {
  "use strict";
});
