// Clipper's plain-JS Emscripten build ships without types. The factory fills the
// object it is given with the native API and resolves once it is ready.
declare module 'js-angusj-clipper/web/wasm/clipper.js' {
  const createClipperModule: (module: object) => Promise<unknown>;
  export default createClipperModule;
}
