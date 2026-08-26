// Corpus: COR-5 incident — the only textual `sap.ui.define([` in this module
// lives inside a regex literal. The head search masks regex bodies, so no
// phantom imports may appear (pre-COR-5 this fabricated 'sap/m/Button').
function findDefine(src) {
  return src.match(/sap.ui.define([ 'sap/m/Button' ])/);
}
