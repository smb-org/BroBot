import { Component, createElement, lazy, Suspense, useCallback, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";

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
  onRetry?: () => void;
}

const lazyViews = new Map<string, unknown>();

const lazyViewFor = <TProperties extends object>(
  instanceKey: string,
  load: () => Promise<{ default: ComponentType<TProperties> }>,
): LazyExoticComponent<ComponentType<TProperties>> => {
  const cached = lazyViews.get(instanceKey);
  if (cached !== undefined) return cached as LazyExoticComponent<ComponentType<TProperties>>;
  const view = lazy<ComponentType<TProperties>>(load);
  lazyViews.set(instanceKey, view);
  return view;
};

/** Loads one lazy view at a time and creates a fresh React.lazy instance after a failed import. */
const LazyAttempt = <TProperties extends object>({
  instanceKey,
  load,
  properties,
  loadingFallback,
  renderError,
  retry,
  suspendToParent = false,
}: Omit<RetryableLazyProperties<TProperties>, "onRetry"> & { retry: () => void }): ReactNode => {
  // Keep the lazy type outside the suspended render: React can discard useMemo caches
  // when the first route attempt suspends, which would otherwise restart the import.
  const LazyView = lazyViewFor(instanceKey, load);

  return (
    <LazyLoadErrorBoundary retry={retry} renderError={renderError}>
      {suspendToParent
        ? createElement(LazyView, properties)
        : <Suspense fallback={loadingFallback}>{createElement(LazyView, properties)}</Suspense>}
    </LazyLoadErrorBoundary>
  );
};

export const RetryableLazy = <TProperties extends object>(properties: RetryableLazyProperties<TProperties>): ReactNode => {
  const { instanceKey, onRetry, ...attemptProperties } = properties;
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => {
    if (onRetry !== undefined) {
      onRetry();
      return;
    }
    lazyViews.delete(`${instanceKey}:${String(generation)}`);
    setGeneration((current) => current + 1);
  }, [generation, instanceKey, onRetry]);

  return <LazyAttempt
    key={`${instanceKey}:${String(generation)}`}
    {...attemptProperties}
    instanceKey={`${instanceKey}:${String(generation)}`}
    retry={retry}
  />;
};
