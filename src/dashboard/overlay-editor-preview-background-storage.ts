export type OverlayEditorPreviewBackgroundMode = "transparent" | "light" | "dark" | "image";

export interface StoredOverlayEditorPreviewBackground {
  mode: OverlayEditorPreviewBackgroundMode;
  image: Blob | null;
}

const MODE_KEY = "brobot.overlay-editor.preview-background";
const DATABASE_NAME = "brobot-overlay-editor-preview";
const DATABASE_VERSION = 1;
const IMAGE_STORE = "backgrounds";
const IMAGE_KEY = "custom";

const isPreviewBackgroundMode = (value: string | null): value is OverlayEditorPreviewBackgroundMode =>
  value === "transparent" || value === "light" || value === "dark" || value === "image";

const readStoredMode = (): OverlayEditorPreviewBackgroundMode => {
  try {
    const value = globalThis.localStorage.getItem(MODE_KEY);
    return isPreviewBackgroundMode(value) ? value : "transparent";
  } catch {
    return "transparent";
  }
};

export const storeOverlayEditorPreviewBackgroundMode = (mode: OverlayEditorPreviewBackgroundMode): void => {
  try {
    globalThis.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage is an optional editor aid.
  }
};

const openImageDatabase = async (): Promise<IDBDatabase | null> => {
  try {
    if (!("indexedDB" in globalThis)) return null;
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains(IMAGE_STORE)) request.result.createObjectStore(IMAGE_STORE);
        } catch {
          reject(new Error("Preview image storage is unavailable."));
        }
      };
      request.onsuccess = () => {
        try {
          resolve(request.result);
        } catch {
          reject(new Error("Preview image storage is unavailable."));
        }
      };
      request.onerror = () => {
        try {
          reject(request.error ?? new Error("Preview image storage is unavailable."));
        } catch {
          reject(new Error("Preview image storage is unavailable."));
        }
      };
      request.onblocked = () => { reject(new Error("Preview image storage is unavailable.")); };
    });
    return database;
  } catch {
    return null;
  }
};

const closeDatabase = (database: IDBDatabase): void => {
  try {
    database.close();
  } catch {
    // A closed database is already unavailable.
  }
};

const readStoredImage = async (): Promise<Blob | null> => {
  const database = await openImageDatabase();
  if (database === null) return null;
  try {
    return await new Promise<Blob | null>((resolve) => {
      let image: Blob | null = null;
      const transaction = database.transaction(IMAGE_STORE, "readonly");
      const request = transaction.objectStore(IMAGE_STORE).get(IMAGE_KEY);
      request.onsuccess = () => {
        try {
          image = request.result instanceof Blob ? request.result : null;
        } catch {
          image = null;
        }
      };
      transaction.oncomplete = () => { resolve(image); };
      transaction.onerror = () => { resolve(null); };
      transaction.onabort = () => { resolve(null); };
    });
  } catch {
    return null;
  } finally {
    closeDatabase(database);
  }
};

const writeStoredImage = async (image: Blob | null): Promise<void> => {
  const database = await openImageDatabase();
  if (database === null) return;
  try {
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(IMAGE_STORE, "readwrite");
      const store = transaction.objectStore(IMAGE_STORE);
      if (image === null) store.delete(IMAGE_KEY);
      else store.put(image, IMAGE_KEY);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { resolve(); };
      transaction.onabort = () => { resolve(); };
    });
  } catch {
    // The current preview remains usable for this page view.
  } finally {
    closeDatabase(database);
  }
};

export const loadOverlayEditorPreviewBackground = async (): Promise<StoredOverlayEditorPreviewBackground> => {
  const mode = readStoredMode();
  if (mode !== "image") return { mode, image: null };
  const image = await readStoredImage();
  return image === null ? { mode: "transparent", image: null } : { mode, image };
};

export const storeOverlayEditorPreviewImage = (image: Blob): Promise<void> => writeStoredImage(image);

export const removeStoredOverlayEditorPreviewImage = (): Promise<void> => writeStoredImage(null);
