import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { Materialized } from "@trestleinc/replicate/client";
import { intervals, type Interval } from "../collections/useIntervals";
import { comments, type Comment } from "../collections/useComments";

interface IntervalsContextValue {
  collection: ReturnType<typeof intervals.get>;
  intervals: Interval[];
  isLoading: boolean;
}

const IntervalsContext = createContext<IntervalsContextValue | null>(null);

let persistenceInitialized = false;

interface PersistenceGateProps {
  children: ReactNode;
  intervalsMaterial?: Materialized<Interval>;
  commentsMaterial?: Materialized<Comment>;
}

function PersistenceGate({ children, intervalsMaterial, commentsMaterial }: PersistenceGateProps) {
  const [ready, setReady] = useState(persistenceInitialized);

  useEffect(() => {
    if (!ready) {
      Promise.all([
        intervals.init(intervalsMaterial),
        comments.init(commentsMaterial),
      ]).then(() => {
        persistenceInitialized = true;
        setReady(true);
      });
    }
  }, [ready, intervalsMaterial, commentsMaterial]);

  if (!ready) {
    return null; // Let the splash screen handle loading state
  }

  return <>{children}</>;
}

function IntervalsProviderInner({ children }: { children: ReactNode }) {
  const collection = intervals.get();
  const { data: intervalsData = [], isLoading } = useLiveQuery(collection);

  return (
    <IntervalsContext.Provider
      value={{
        collection,
        intervals: intervalsData,
        isLoading,
      }}
    >
      {children}
    </IntervalsContext.Provider>
  );
}

interface IntervalsProviderProps {
  children: ReactNode;
  intervalsMaterial?: Materialized<Interval>;
  commentsMaterial?: Materialized<Comment>;
}

export function IntervalsProvider({ children, intervalsMaterial, commentsMaterial }: IntervalsProviderProps) {
  return (
    <PersistenceGate intervalsMaterial={intervalsMaterial} commentsMaterial={commentsMaterial}>
      <IntervalsProviderInner>{children}</IntervalsProviderInner>
    </PersistenceGate>
  );
}

export function useIntervalsContext() {
  const ctx = useContext(IntervalsContext);
  if (!ctx) {
    throw new Error("useIntervalsContext must be used within IntervalsProvider");
  }
  return ctx;
}
