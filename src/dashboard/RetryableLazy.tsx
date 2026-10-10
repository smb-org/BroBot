import { Component, createElement, lazy, Suspense, useCallback, useMemo, useState, type ComponentType, type ReactNode } from "react";

interface LazyLoadErrorBoundaryProperties {
  children: ReactNode;
  renderError: (retry: () => void) => ReactNode;
  retry: () => void;
}

interface LazyLoadErrorBoundaryState {
  hasError: boolean;
}

class LazyLoadErrorBoundary extends Component<LazyLoadErrorBoundaryProperties, LazyLoadErrorBoundaryState> {
  override state: LazyLoadErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LazyLoadErrorBoundaryState {
    return { hasError: true };
  }

  override render(): ReactNode {
    return this.state.hasError ? this.props.renderError(this.props.retry) : this.props.children;
  }
}

interface RetryableLazyProperties<TProperties extends object> {
  instanceKey: string;
  load: () => Promise<{ default: ComponentType<TProperties> }>;
  properties: TProperties;
  loadingFallback: ReactNode;
  renderError: (retry: () => void) => ReactNode;
  suspendToParent?: boolean;
}

/** Loads one lazy view at a time and creates a fresh React.lazy instance after a failed import. */
const LazyAttempt = <TProperties extends object>({
  load,
  properties,
  loadingFallback,
  renderError,
  retry,
  suspendToParent = false,
}: Omit<RetryableLazyProperties<TProperties>, "instanceKey"> & { retry: () => void }): ReactNode => {
  const LazyView = useMemo(() => lazy(load), [load]);

  return (
    <LazyLoadErrorBoundary retry={retry} renderError={renderError}>
      {suspendToParent
        ? createElement(LazyView, properties)
        : <Suspense fallback={loadingFallback}>{createElement(LazyView, properties)}</Suspense>}
    </LazyLoadErrorBoundary>
  );
};

export const RetryableLazy = <TProperties extends object>(properties: RetryableLazyProperties<TProperties>): ReactNode => {
  const { instanceKey, ...attemptProperties } = properties;
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => { setGeneration((current) => current + 1); }, []);

  return <LazyAttempt key={`${instanceKey}:${String(generation)}`} {...attemptProperties} retry={retry} />;
};
