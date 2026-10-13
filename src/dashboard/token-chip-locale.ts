import type { LocaleCatalog } from "./locale";

interface TokenChipTexts {
  copied: string;
  copyFailed: string;
  copyLabel: (token: string) => string;
}

export const tokenChipTexts: LocaleCatalog<TokenChipTexts> = {
  de: {
    copied: "Token kopiert.",
    copyFailed: "Token konnte nicht kopiert werden.",
    copyLabel: (token) => `${token} kopieren`,
  },
  en: {
    copied: "Token copied.",
    copyFailed: "Token could not be copied.",
    copyLabel: (token) => `Copy ${token}`,
  },
};
