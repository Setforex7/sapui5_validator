import MessageBox from "sap/m/MessageBox";
import Controller from "sap/ui/core/mvc/Controller";

/**
 * @namespace ui5.typescript.helloworld.controller
 */
export default class App extends Controller {
  public onInit(): void {
    /* noop */
  }

  public sayHello(): void {
    MessageBox.show("Hello World!");
  }
}
