/** WebAssembly modules, embedded as bytes by the bundle (binary loader) */
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
