/**
 * Fonte do card (Inter, OFL, servida pelo próprio app em /fonts). Carregada ANTES de medir texto:
 * prévia e arquivo final usam exatamente a mesma fonte. Emoji usam a fonte de emoji do sistema.
 */
let loading: Promise<void> | null = null;

export function ensureCardFonts(): Promise<void> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const faces = [
        new FontFace("Inter", "url(/fonts/inter-latin-wght-normal.woff2) format('woff2')", {
          weight: "100 900",
          unicodeRange: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
        }),
        new FontFace("Inter", "url(/fonts/inter-latin-ext-wght-normal.woff2) format('woff2')", {
          weight: "100 900",
          unicodeRange: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
        }),
      ];
      for (const f of faces) document.fonts.add(f);
      await Promise.all(faces.map((f) => f.load()));
      await document.fonts.ready;
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
