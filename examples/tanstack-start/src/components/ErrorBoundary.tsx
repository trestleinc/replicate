import React from "react";
import { getLogger } from "../lib/logger";

const logger = getLogger("error-boundary");

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary component for catching React errors in ConvexRx
 * Prevents the entire app from crashing when sync or rendering errors occur
 */
export class ConvexRxErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error("Error Boundary caught error", { error, errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    // Reload the page to reset state
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h1 className="error-boundary-title">Something went wrong</h1>
          <p className="error-boundary-message">An error occurred while syncing data:</p>
          <pre className="error-boundary-error">{this.state.error?.message || "Unknown error"}</pre>
          {this.state.error?.stack && (
            <details className="error-boundary-details">
              <summary>Stack trace</summary>
              <pre className="error-boundary-stack">{this.state.error.stack}</pre>
            </details>
          )}
          <button type="button" onClick={this.handleReset} className="error-boundary-btn">
            Reload Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
