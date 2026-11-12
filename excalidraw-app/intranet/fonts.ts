/**
 * Intranet fork (E3): the company's fonts, uploaded by the app admins. They
 * join the editor's fonts before a scene loads: in the font menu, for text
 * that uses them, embedded in exports.
 */
import { Fonts } from "@excalidraw/excalidraw/fonts/Fonts";

export interface CompanyFont {
  id: number;
  family: string;
  url: string;
  metrics: {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    lineHeight: number;
  };
}

export const registerCompanyFonts = (fonts: readonly CompanyFont[] = []) => {
  for (const font of fonts) {
    Fonts.registerCompanyFont({
      family: font.family,
      id: font.id,
      // absolute: the editor fetches it for exports, too
      url: new URL(font.url, window.location.origin).toString(),
      metrics: font.metrics,
    });
  }
};
