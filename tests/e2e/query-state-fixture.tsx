import { createRoot } from "react-dom/client";
import { useState } from "react";

import { ListToolbar, LoadState, UiProvider } from "../../src/dashboard/ui";
import "../../src/dashboard/styles.css";

type RequestState = "loading" | "initial-error" | "success" | "refresh-error";

const errorMessage = "The saved channel settings could not be refreshed because the request timed out while the service was unavailable.";
const limitReason = "25 of 25 channel variables are in use. Delete one before creating another.";

export const QueryStateFixture = () => {
  const [requestState, setRequestState] = useState<RequestState>("loading");
  const hasError = requestState === "initial-error" || requestState === "refresh-error";
  const queryError = hasError ? { message: errorMessage, onRetry: () => { setRequestState("success"); } } : undefined;
  const status = requestState === "loading" ? "loading" : requestState === "initial-error" ? "error" : "success";
  const refreshError = requestState === "refresh-error";

  return (
    <main style={{ boxSizing: "border-box", width: "100%", maxWidth: 960, padding: 16 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={() => { setRequestState("initial-error"); }}>Fail initial request</button>
        <button type="button" onClick={() => { setRequestState("refresh-error"); }}>Fail background refresh</button>
      </div>
      <ListToolbar
        searchLabel="Search variables"
        searchPlaceholder="Search variables"
        searchClearLabel="Clear search"
        searchValue=""
        onSearchChange={() => undefined}
        filtersLabel="Variable filters"
        filters={<button className="button button--secondary" type="button">Role filter</button>}
        create={{ label: "Create variable", onClick: () => undefined, disabled: true, reason: limitReason }}
        usage={{ count: 25, maximum: 25, copy: { countSuffix: "variables", filteredInfix: "of", filteredSuffix: "shown", limitInfix: "of", limitSuffix: "used", loadedSuffix: "loaded" } }}
        activeFilters="Role: Manager"
        activeFiltersLabel="Active filter"
        resetLabel="Reset"
        onReset={() => undefined}
        {...(queryError === undefined ? {} : { queryError })}
      />
      <section aria-label="Compact editor state">
        <LoadState
          variant="compact-64"
          className="compact-load"
          status={status}
          loading={<div />}
          empty={<div />}
          error={<div />}
          {...(queryError === undefined ? {} : { queryError })}
        >{null}</LoadState>
      </section>
      <section aria-label="Module settings state">
        <LoadState
          variant="panel-320"
          className="panel-load"
          status={status}
          loading={<div />}
          empty={<div />}
          error={<div />}
          queryError={{ message: errorMessage, onRetry: () => { setRequestState("success"); } }}
          refreshError={refreshError}
        >{requestState === "loading" || requestState === "initial-error" ? null : <p>Cached settings remain visible.</p>}</LoadState>
      </section>
    </main>
  );
};

createRoot(document.getElementById("root") as HTMLElement).render(<UiProvider><QueryStateFixture /></UiProvider>);
