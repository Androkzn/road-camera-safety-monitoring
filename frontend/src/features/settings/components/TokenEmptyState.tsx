/**
 * TokenEmptyState — no-token empty state for the Settings Console.
 *
 * Extracted from SettingsPage (D1.A) so the page orchestrator can
 * render a single `<TokenEmptyState {...props} />` instead of inlining
 * the `<TokenPrompt>` + TopBar region. Keeps the DOM and classNames
 * identical to what SettingsPage used to render directly.
 */
import { TokenPrompt } from "./TokenPrompt";

interface TokenEmptyStateProps {
  sourceName: string;
  connected?: boolean;
  errorCount?: number;
  driftCount?: number;
  error: string | null;
  onSave: (token: string) => void;
}

export function TokenEmptyState({
  sourceName,
  connected,
  errorCount,
  driftCount,
  error,
  onSave,
}: TokenEmptyStateProps) {
  return (
    <TokenPrompt
      sourceName={sourceName}
      connected={connected}
      errorCount={errorCount}
      driftCount={driftCount}
      error={error}
      onSave={onSave}
    />
  );
}
