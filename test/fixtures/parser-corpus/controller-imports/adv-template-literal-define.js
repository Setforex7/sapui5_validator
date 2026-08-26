// Corpus: adversarial — a template literal carrying `sap.ui.define([...])`
// TEXT sits ABOVE the real define. stripJsComments preserves template-literal
// contents (they are strings, not comments), so the head regex sees the text
// inside the template too. Expectation pinned EMPIRICALLY by the spec.
const doc = `example:
sap.ui.define(["fake/dep"], function (F) { return F; });
`;
sap.ui.define(["sap/m/Text"], function (Text) {
  "use strict";
  return { doc: doc };
});
