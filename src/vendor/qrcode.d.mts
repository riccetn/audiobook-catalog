// The types of the QR code library make pages copies into public/vendor/ (build.mjs), so import.ts can load it as
// it is served; the package's own declarations describe it.
declare const qrcode: typeof import('qrcode-generator');
export default qrcode;
