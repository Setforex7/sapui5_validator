// Corpus: adversarial — commented-out ES imports must not parse.
// import Evil from "sap/evil/Thing";
/* import Other from "sap/other/Thing"; */
import Controller from "sap/ui/core/mvc/Controller";

export default class Corpus extends Controller {
  public noop(): void {
    void 0;
  }
}
