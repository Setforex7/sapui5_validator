// Corpus: adversarial — nested template literals near a live define. The
// comment-masker's backtick handling is a naive toggle (no ${} awareness),
// so nesting flips its in-string state at each backtick. Pinned empirically.
const msg = `outer ${ `inner` } outer`;
sap.ui.define(["sap/m/Text"], function (Text) {
  "use strict";
  return { msg: msg };
});
// tail comment after the define
