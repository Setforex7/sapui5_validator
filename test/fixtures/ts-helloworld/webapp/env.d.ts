// Ambient declaration — NOT a SAPUI5 source/controller. Discovery must exclude
// `.d.ts` from controller scope (GA1-01); detection must not count it as TS
// source on its own (a JS project may ship hand-written declarations).
declare module "*.properties" {
  const content: string;
  export default content;
}
