import { Component, type ReactNode } from "react";

interface DashboardPageErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface DashboardPageErrorBoundaryState {
  hasError: boolean;
}

/** Keeps a failed route inside the dashboard shell. */
export class DashboardPageErrorBoundary extends Component<DashboardPageErrorBoundaryProps, DashboardPageErrorBoundaryState> {
  override state: DashboardPageErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): DashboardPageErrorBoundaryState {
    return { hasError: true };
  }

  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
