import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { overlaysTexts, type DashboardLanguage } from "./locale";
import { Button, FilePicker, Select } from "./ui";
import {
  loadOverlayEditorPreviewBackground,
  loadStoredOverlayEditorPreviewImage,
  removeStoredOverlayEditorPreviewImage,
  storeOverlayEditorPreviewBackgroundMode,
  storeOverlayEditorPreviewImage,
  type OverlayEditorPreviewBackgroundMode,
} from "./overlay-editor-preview-background-storage";

interface OverlayEditorPreviewBackgroundRenderValue {
  mode: OverlayEditorPreviewBackgroundMode;
  imageUrl: string | null;
}

interface OverlayEditorPreviewBackgroundProperties {
  language: DashboardLanguage;
  children: (background: OverlayEditorPreviewBackgroundRenderValue) => ReactNode;
}

const MAXIMUM_PREVIEW_IMAGE_SIZE = 10 * 1024 * 1024;

export function OverlayEditorPreviewBackground({ language, children }: OverlayEditorPreviewBackgroundProperties): ReactElement {
  const labels = overlaysTexts(language);
  const [mode, setMode] = useState<OverlayEditorPreviewBackgroundMode>("transparent");
  const [image, setImageState] = useState<{ url: string | null } | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userChangedBackground = useRef(false);
  const imageLoadGeneration = useRef(0);
  const currentUrl = useRef<string | null>(null);

  // Every image change goes through here so the previous object URL is always revoked.
  const setImage = useCallback((blob: Blob | null): void => {
    if (currentUrl.current !== null) {
      try {
        URL.revokeObjectURL(currentUrl.current);
      } catch {
        // Revocation is best effort when browser URL storage is unavailable.
      }
      currentUrl.current = null;
    }
    if (blob === null) {
      setImageState(null);
      return;
    }
    try {
      currentUrl.current = URL.createObjectURL(blob);
    } catch {
      currentUrl.current = null;
    }
    setImageState({ url: currentUrl.current });
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadOverlayEditorPreviewBackground().then((stored) => {
      if (!mounted || userChangedBackground.current) return;
      setMode(stored.mode);
      setImage(stored.image);
    });
    return () => {
      mounted = false;
      imageLoadGeneration.current += 1;
      setImage(null);
    };
  }, [setImage]);

  const chooseMode = (value: string | null): void => {
    if (value !== "transparent" && value !== "light" && value !== "dark" && value !== "image") return;
    userChangedBackground.current = true;
    setMode(value);
    setError("");
    storeOverlayEditorPreviewBackgroundMode(value);
    if (value === "image" && image === null) {
      const generation = ++imageLoadGeneration.current;
      void loadStoredOverlayEditorPreviewImage().then((storedImage) => {
        if (storedImage !== null && generation === imageLoadGeneration.current) setImage(storedImage);
      });
    }
  };

  const chooseImage = (file: File | undefined): void => {
    if (file === undefined) return;
    if (!file.type.startsWith("image/")) {
      setError(labels.editorPreviewImageTypeError);
    } else if (file.size > MAXIMUM_PREVIEW_IMAGE_SIZE) {
      setError(labels.editorPreviewImageSizeError);
    } else {
      userChangedBackground.current = true;
      imageLoadGeneration.current += 1;
      setError("");
      setImage(file);
      setMode("image");
      storeOverlayEditorPreviewBackgroundMode("image");
      void storeOverlayEditorPreviewImage(file);
    }
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  };

  const removeImage = (): void => {
    userChangedBackground.current = true;
    imageLoadGeneration.current += 1;
    setImage(null);
    setMode("transparent");
    setError("");
    storeOverlayEditorPreviewBackgroundMode("transparent");
    void removeStoredOverlayEditorPreviewImage();
  };

  return <>
    <div className="overlay-editor__preview-background-controls">
      <Select
        id="overlay-editor-preview-background"
        label={labels.editorPreviewBackground}
        compact
        value={mode}
        options={[
          { value: "transparent", label: labels.editorPreviewBackgroundTransparent },
          { value: "light", label: labels.editorPreviewBackgroundLight },
          { value: "dark", label: labels.editorPreviewBackgroundDark },
          { value: "image", label: labels.editorPreviewBackgroundImage },
        ]}
        onChange={chooseMode}
      />
      <div className="overlay-editor__preview-background-actions">
        <FilePicker
          ref={fileInputRef}
          className="sr-only"
          accept="image/*"
          ariaLabel={labels.editorPreviewChooseImage}
          onChange={chooseImage}
        />
        <Button variant="neutral" icon="styleBackground" onClick={() => { fileInputRef.current?.click(); }}>{labels.editorPreviewChooseImage}</Button>
        <Button
          variant="neutral"
          size="compact"
          icon="remove"
          iconOnly
          ariaLabel={labels.editorPreviewRemoveImage}
          title={labels.editorPreviewRemoveImage}
          disabled={image === null}
          onClick={removeImage}
        />
      </div>
      <p className="overlay-editor__preview-background-error" role="status" aria-live="polite">{error}</p>
    </div>
    {children({ mode, imageUrl: mode === "image" ? image?.url ?? null : null })}
  </>;
}
