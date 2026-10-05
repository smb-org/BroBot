import { createRoot } from "react-dom/client";
import { useState } from "react";

import { EditorShell, Field, FormDialog, ListDetail, UiProvider } from "../../src/dashboard/ui";
import "../../src/dashboard/styles.css";
import "./host-popovers-fixture.css";

const fieldMessages = {
  alpha: "Enter a valid alpha value.",
  beta: "Choose a value below the allowed maximum.",
  gamma: "This complete error explains how to correct the value without leaving the editor.",
};
const invalidFields = [
  { id: "field-alpha", label: "Alpha", message: fieldMessages.alpha, sectionId: "settings" },
  { id: "field-beta", label: "Beta", message: fieldMessages.beta, sectionId: "settings" },
  { id: "field-gamma", label: "Gamma", message: fieldMessages.gamma, sectionId: "settings" },
];

const longHint = "This complete hint stays readable when it is longer than the reserved field row and the editor clips its scrolling body. ".repeat(2);
const longDialogError = "This complete dialog error stays readable near the right edge and ends with the step needed to correct the request.";

export function HostPopoversFixture() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const conflictMode = new URLSearchParams(window.location.search).has("conflict");

  return (
    <UiProvider>
      <main className="host-popovers-fixture">
        <ListDetail
          list={<div aria-label="Editor list" />}
          inspector={inspectorOpen ? <EditorShell
            className="host-popovers-fixture__editor"
            ariaLabel="Host popover editor"
            title="Popover checks"
            dirty
            invalid
            invalidMessage="Please correct the marked fields."
            invalidFields={invalidFields}
            sections={[{
              id: "settings",
              label: "Settings",
              content: (
                <>
                  <details>
                    <summary>Advanced values</summary>
                    <Field id="field-alpha" label="Alpha" value="" error={fieldMessages.alpha} onChange={() => {}} />
                    <Field id="field-beta" label="Beta" value="" error={fieldMessages.beta} onChange={() => {}} />
                  </details>
                  <div className="host-popovers-fixture__spacer" aria-hidden="true" />
                  <Field id="field-gamma" label="Gamma" value="" hint={longHint} error={fieldMessages.gamma} onChange={() => {}} />
                </>
              ),
            }]}
            {...(conflictMode ? { conflict: { message: "The server version changed.", reloadLabel: "Serverstand laden", onReload: () => {} } } : {})}
            onSave={() => {}}
            onDiscard={() => {}}
            saveLabel="Save"
            discardLabel="Discard"
            savedLabel="Saved."
            pendingLabel="Saving…"
            issueLabels={{ error: "error", warning: "warning" }}
            onClose={() => { setInspectorOpen(false); }}
            closeLabel="Close inspector"
          /> : null}
          onCloseInspector={() => { setInspectorOpen(false); }}
        />
        <button type="button" onClick={() => { setDialogOpen(true); }}>Open dialog</button>
        <FormDialog
          opened={dialogOpen}
          title="Long message dialog"
          children={<p>Dialog content.</p>}
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => {}}
          onCancel={() => { setDialogOpen(false); }}
          error={longDialogError}
        />
      </main>
    </UiProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<HostPopoversFixture />);
