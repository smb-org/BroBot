import { ErrorPanel } from "./ErrorPanel";

export interface QueryErrorStateProps {
  title: string;
  reason: string;
  retryLabel: string;
  onRetry: () => void;
}

export function QueryErrorState({ title, reason, retryLabel, onRetry }: QueryErrorStateProps) {
  return <ErrorPanel title={title} reason={reason} action={{ label: retryLabel, onClick: onRetry }} />;
}
