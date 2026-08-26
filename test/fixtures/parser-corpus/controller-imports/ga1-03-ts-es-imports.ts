// Corpus: V1.9 GA1-03 — the four static ES-import forms a TS-SAPUI5 controller
// uses, plus the two EXCLUDED classes (relative + type-only). parseEsModuleImports
// returns the non-relative, non-type-only specifiers in first-occurrence order;
// parseControllerImports is inert ([]) on this file — there is no sap.ui.define head.
import Controller from "sap/ui/core/mvc/Controller";
import { Button, Dialog as D } from "sap/m/library";
import * as core from "sap/ui/core/library";
import "sap/ui/core/sample/SideEffect";
import AppComponent from "../Component";
import { formatter } from "./util/formatter";
import type Metadata from "sap/ui/core/Element";
import type { Route } from "sap/ui/core/routing/Router";

export default class Corpus extends Controller {
  public go(): void {
    void [Button, D, core, AppComponent, formatter];
  }
}
