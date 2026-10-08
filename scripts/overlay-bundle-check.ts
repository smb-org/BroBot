interface OverlayBundleAsset {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}

interface OverlayBundleChunk {
  type: "chunk";
  fileName: string;
  imports: string[];
  dynamicImports: string[];
  modules: Record<string, unknown>;
  code: string;
}

export type OverlayBundle = Record<string, OverlayBundleAsset | OverlayBundleChunk>;

const asChunk = (entry: OverlayBundleAsset | OverlayBundleChunk): entry is OverlayBundleChunk =>
  entry.type === "chunk";

const isOverlayHtml = (entry: OverlayBundleAsset | OverlayBundleChunk): entry is OverlayBundleAsset =>
  entry.type === "asset" && (entry.fileName === "overlay.html" || entry.fileName.endsWith("/overlay.html"));

const resolveBundleFile = (reference: string, bundle: OverlayBundle): string | null => {
  const path = reference.split(/[?#]/, 1)[0] ?? reference;
  const normalized = path.replace(/^(?:\.\/|\/)+/, "");
  if (bundle[normalized] !== undefined) return normalized;
  return Object.keys(bundle).find((fileName) => path.endsWith(`/${fileName}`)) ?? null;
};

export const assertOverlayBundleHasNoTanstack = (bundle: OverlayBundle): void => {
  const htmlAsset = Object.values(bundle).find(isOverlayHtml);
  if (htmlAsset === undefined) throw new Error("The client build is missing overlay.html.");

  const html = typeof htmlAsset.source === "string" ? htmlAsset.source : new TextDecoder().decode(htmlAsset.source);
  const references: string[] = [];
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/g)) {
    const reference = match[1];
    if (reference !== undefined) references.push(reference);
  }
  if (references.length === 0) throw new Error("overlay.html does not reference a JavaScript entry chunk.");

  const pending = references.map((reference) => {
    const fileName = resolveBundleFile(reference, bundle);
    if (fileName === null) throw new Error(`Unable to resolve overlay bundle reference: ${reference}`);
    return fileName;
  });
  const visited = new Set<string>();

  while (pending.length > 0) {
    const fileName = pending.pop();
    if (fileName === undefined || visited.has(fileName)) continue;
    visited.add(fileName);
    const entry = bundle[fileName];
    if (entry === undefined || !asChunk(entry)) continue;

    const tanstackModule = Object.keys(entry.modules).find((moduleId) =>
      moduleId.includes("@tanstack/") || moduleId.includes("@tanstack+"));
    if (tanstackModule !== undefined || entry.code.includes("@tanstack/")) {
      throw new Error(`Overlay chunk ${fileName} includes TanStack Query${tanstackModule === undefined ? "" : ` (${tanstackModule})`}.`);
    }

    pending.push(...entry.imports, ...entry.dynamicImports);
  }
};
