export type Palette = "nachtschicht" | "indigo-nacht";

const storageKey = "brobot.palette";

export const readPalette = (): Palette => {
  if (typeof window === "undefined") return "nachtschicht";

  try {
    const storedPalette = window.localStorage.getItem(storageKey);
    return storedPalette === "indigo-nacht" ? storedPalette : "nachtschicht";
  } catch {
    return "nachtschicht";
  }
};

export const writePalette = (palette: Palette): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.palette = palette;

  try {
    window.localStorage.setItem(storageKey, palette);
  } catch {
    // The palette still applies when browser storage is unavailable.
  }
};
