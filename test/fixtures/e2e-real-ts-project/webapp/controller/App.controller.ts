import MessageBox from "sap/m/MessageBox";
import Controller from "sap/ui/core/mvc/Controller";

/**
 * @namespace e2e.real.ts.controller
 */
export default class App extends Controller {
  public onInit(): void {
    /* noop */
  }

  public sayHello(): void {
    MessageBox.show("Hello World!");
  }
}
